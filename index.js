import fs from 'fs';
import Parser from 'rss-parser';
import { GoogleGenerativeAI } from '@google/generative-ai';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();
const parser = new Parser();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

// 1. 날짜 변환 함수
function formatDate(dateStr) {
    try {
        if (!dateStr) return '';
        const d = new Date(dateStr);
        return d.toISOString().split('T')[0].substring(2); 
    } catch (e) { return ''; }
}

// 2. 24시간 필터링 함수
function isRecent(dateStr, timeWindow) {
    if (!dateStr) return false;
    const pubDate = new Date(dateStr).getTime();
    const now = Date.now();
    let maxAgeHours = 24; 
    if (timeWindow.includes('d')) maxAgeHours = parseInt(timeWindow) * 24;
    else if (timeWindow.includes('h')) maxAgeHours = parseInt(timeWindow);
    return (now - pubDate) <= (maxAgeHours * 60 * 60 * 1000);
}

// 3. HTML 태그 제거 함수
function cleanHtml(text) {
    if (!text) return '';
    return text.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// ⭐ 4. [신규] 제목 유사도 계산 함수 (보도자료 도배 방지)
function calculateTitleSimilarity(title1, title2) {
    // 공백을 없애고 2글자씩 쪼개서 비교 (Bi-gram 방식)
    const tokenize = text => {
        const cleanText = text.replace(/\s+/g, '').toLowerCase();
        const tokens = new Set();
        for (let i = 0; i < cleanText.length - 1; i++) {
            tokens.add(cleanText.substring(i, i + 2));
        }
        return tokens;
    };

    const set1 = tokenize(title1);
    const set2 = tokenize(title2);

    let intersection = 0;
    for (const token of set1) {
        if (set2.has(token)) intersection++;
    }

    const union = set1.size + set2.size - intersection;
    return union === 0 ? 0 : (intersection / union);
}

// 5. 네이버 뉴스 수집 함수
async function fetchNaverNews(keyword, timeWindow) {
    const clientId = process.env.NAVER_CLIENT_ID;
    const clientSecret = process.env.NAVER_CLIENT_SECRET;
    if (!clientId || !clientSecret) return [];

    const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(keyword)}&display=30&sort=date`;
    try {
        const response = await fetch(url, {
            headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret }
        });
        const data = await response.json();
        if (!data.items) return [];

        return data.items
            .filter(item => isRecent(item.pubDate, timeWindow))
            .slice(0, 15)
            .map(item => ({
                source: '네이버뉴스', title: cleanHtml(item.title), link: item.link, snippet: cleanHtml(item.description), date: formatDate(item.pubDate)
            }));
    } catch (e) { return []; }
}

// 6. 구글 뉴스 수집 함수
async function safeFetchRSS(url) {
    try {
        const feed = await parser.parseURL(url);
        return feed.items;
    } catch (e) { return []; }
}

// ================= 메인 실행 함수 =================
async function main() {
    try {
        const windowCode = config.timeWindow.replace(/([0-9]+)([a-zA-Z]+)/, '$2$1');
        console.log(`🚀 뉴스 수집 시작 (검색 기간: ${config.timeWindow})`);
        
        const groupedNews = {};
        let totalArticles = 0;

        for (const keyword of config.keywords) {
            console.log(`\n🔍 [키워드: ${keyword}] 수집 중...`);
            let keywordNews = [];

            const gnUrl = config.googleNewsApi.replace('{keyword}', encodeURIComponent(keyword)).replace('{window}', windowCode);
            const gnItems = await safeFetchRSS(gnUrl);
            const gnMapped = gnItems
                .filter(item => isRecent(item.pubDate, config.timeWindow))
                .slice(0, 15).map(item => ({ 
                    source: '구글뉴스', title: cleanHtml(item.title), link: item.link, snippet: cleanHtml(item.contentSnippet || '').substring(0, 150), date: formatDate(item.pubDate)
                }));
            keywordNews = keywordNews.concat(gnMapped);

            const naverItems = await fetchNaverNews(keyword, config.timeWindow);
            keywordNews = keywordNews.concat(naverItems);

            // ⭐ [핵심 개선] URL 중복 + 제목 유사도 중복 철저 필터링
            const uniqueItems = [];
            keywordNews.forEach(item => {
                const cleanUrl = item.link.split('?')[0];
                item.link = cleanUrl;

                // 1차 방어: 똑같은 URL 차단
                const isUrlDuplicate = uniqueItems.some(existing => existing.link === item.link);
                if (isUrlDuplicate) return;

                // 2차 방어: 제목이 40% 이상 비슷하면(보도자료 복붙) 차단
                const isTitleDuplicate = uniqueItems.some(existing => calculateTitleSimilarity(existing.title, item.title) > 0.4);
                if (isTitleDuplicate) return;

                uniqueItems.push(item);
            });
            
            groupedNews[keyword] = uniqueItems;
            totalArticles += uniqueItems.length;
            console.log(`   - 최종 정제된 기사 수: ${uniqueItems.length}개 (중복 스팸 제거 완료)`);
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

            const prompt = `당신은 핵심만 분석하는 기업 전략가입니다. '${keyword}'에 대한 최신 주요 뉴스입니다.
            [지침]
            1. 제공된 뉴스들의 공통된 흐름을 파악하여 2~3줄로 요약하세요.
            2. 주가 등락 같은 단순 수치보다는 비즈니스적 의미(전략, 계약, 정책)에 집중하세요.
            3. 인사말이나 맺음말 없이 핵심 텍스트만 출력하세요.
            
            [뉴스 데이터]
            ${newsData}`;
            
            const result = await model.generateContent(prompt);
            const summary = result.response.text().trim();

            finalHtmlContent += `<h3>&lt;${keyword}&gt;</h3>\n<p>${summary}</p>\n`;
            
            // 메일에는 최대 10개의 핵심 기사만 노출하여 가독성 확보
            items.slice(0, 10).forEach(n => {
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
