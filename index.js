import fs from 'fs';
import Parser from 'rss-parser';
import { GoogleGenerativeAI } from '@google/generative-ai';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();
const parser = new Parser();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

// 날짜를 YY-MM-DD 형식으로 변환
function formatDate(dateStr) {
    try {
        if (!dateStr) return '';
        const d = new Date(dateStr);
        return d.toISOString().split('T')[0].substring(2); 
    } catch (e) { return ''; }
}

// 네이버 기사의 HTML 태그(<b> 등) 제거 함수
function cleanHtml(text) {
    if (!text) return '';
    return text.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// ⭐ 네이버 뉴스 API 호출 함수
async function fetchNaverNews(keyword) {
    const clientId = process.env.NAVER_CLIENT_ID;
    const clientSecret = process.env.NAVER_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        console.log("   ⚠️ 네이버 API 키가 없습니다. 구글 뉴스만 수집합니다.");
        return [];
    }

    // 네이버 API: 정확도순(sim)으로 최신 20개 검색
    const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(keyword)}&display=20&sort=sim`;

    try {
        const response = await fetch(url, {
            headers: {
                'X-Naver-Client-Id': clientId,
                'X-Naver-Client-Secret': clientSecret
            }
        });
        const data = await response.json();
        if (!data.items) return [];

        return data.items.map(item => ({
            source: '네이버뉴스', // 언론사 이름 대신 네이버뉴스로 통합 표기
            title: cleanHtml(item.title),
            link: item.link,
            snippet: cleanHtml(item.description),
            date: formatDate(item.pubDate)
        }));
    } catch (e) {
        console.error("❌ 네이버 API 에러:", e.message);
        return [];
    }
}

async function safeFetchRSS(url) {
    try {
        const feed = await parser.parseURL(url);
        return feed.items;
    } catch (e) { return []; }
}

async function main() {
    try {
        const windowCode = config.timeWindow.replace(/([0-9]+)([a-zA-Z]+)/, '$2$1');
        console.log(`🚀 뉴스 수집 시작 (검색 기간: ${config.timeWindow} -> 구글 서버 전달값: ${windowCode})`);
        
        const groupedNews = {};
        let totalArticles = 0;

        for (const keyword of config.keywords) {
            console.log(`\n🔍 [키워드: ${keyword}] 수집 중...`);
            let keywordNews = [];

            // 1. 구글 뉴스 수집
            const gnUrl = config.googleNewsApi.replace('{keyword}', encodeURIComponent(keyword)).replace('{window}', windowCode);
            const gnItems = await safeFetchRSS(gnUrl);
            const gnMapped = gnItems.slice(0, 15).map(item => ({ 
                source: '구글뉴스', title: item.title, link: item.link, snippet: (item.contentSnippet || '').substring(0, 150), date: formatDate(item.pubDate)
            }));
            keywordNews = keywordNews.concat(gnMapped);
            console.log(`   - 구글뉴스에서 ${gnMapped.length}개 발견`);

            // 2. ⭐ 네이버 뉴스 수집
            const naverItems = await fetchNaverNews(keyword);
            keywordNews = keywordNews.concat(naverItems);
            console.log(`   - 네이버뉴스에서 ${naverItems.length}개 발견`);

            // 3. 중복 제거 (URL 기준)
            const uniqueMap = new Map();
            keywordNews.forEach(item => {
                const cleanUrl = item.link.split('?')[0];
                if (!uniqueMap.has(cleanUrl)) uniqueMap.set(cleanUrl, item);
            });
            
            groupedNews[keyword] = Array.from(uniqueMap.values());
            totalArticles += groupedNews[keyword].length;
        }

        if (totalArticles === 0) {
            console.log("수집된 뉴스가 없습니다.");
            process.exit(0);
        }

        console.log(`\n🚀 총 수집 기사 수: ${totalArticles}개. AI 테마별 분석 시작...`);
        const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
        
        let finalHtmlContent = "";

        for (const keyword of config.keywords) {
            const items = groupedNews[keyword];
            if (items.length === 0) continue;

            let newsData = items.map(n => `- [${n.source}] ${n.title}\n  (힌트: ${n.snippet})`).join('\n\n');

            const prompt = `당신은 핵심만 분석하는 기업 전략가입니다. '${keyword}'에 대한 뉴스 리스트입니다.
            [지침]
            1. 동일한 사건(예: 특정 수주, 주가 등락)에 대한 중복 기사가 많다면 하나로 묶어 요약하세요.
            2. 단순 시황 정보는 짧게 통합하고, 실질적인 기업의 비즈니스 활동에 집중하세요.
            3. 인사말 없이 '${keyword}'의 핵심 동향을 2~3줄로만 요약하세요.
            
            [뉴스 데이터]
            ${newsData}`;
            
            const result = await model.generateContent(prompt);
            const summary = result.response.text().trim();

            finalHtmlContent += `<h3>&lt;${keyword}&gt;</h3>\n<p>${summary}</p>\n`;
            
            items.slice(0, 15).forEach(n => {
                finalHtmlContent += `${n.source} / ${n.date} / <a href="${n.link}" target="_blank" style="text-decoration:none; color:#1a73e8;">${n.title}</a><br>\n`;
            });
            finalHtmlContent += `<br><br>\n`;
        }

        const transporter = nodemailer.createTransport({
            service: 'gmail', host: 'smtp.gmail.com', port: 465, secure: true,
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_APP_PASS }
        });

        await transporter.sendMail({
            from: process.env.EMAIL_USER, to: config.recipientEmail, subject: config.emailSubject, html: finalHtmlContent
        });

        console.log("✅ 브리핑 발송 완료!");
        process.exit(0); 

    } catch (error) {
        console.error("❌ 에러:", error);
        process.exit(1);
    }
}

main();
