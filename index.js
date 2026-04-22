import fs from 'fs';
import Parser from 'rss-parser';
import { GoogleGenerativeAI } from '@google/generative-ai';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();
const parser = new Parser();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

async function safeFetchRSS(url) {
    try {
        const feed = await parser.parseURL(url);
        return feed.items;
    } catch (e) {
        // 에러 로그는 디버깅용으로만 남기고 스크립트는 계속 진행됩니다.
        return []; 
    }
}

async function main() {
    try {
        console.log("🚀 키워드 중심 뉴스 수집을 시작합니다...");
        const groupedNews = {};
        let totalArticles = 0;

        for (const keyword of config.keywords) {
            console.log(`\n🔍 [키워드: ${keyword}] 수집 중...`);
            let keywordNews = [];

            const gnUrl = config.googleNewsApi.replace('{keyword}', encodeURIComponent(keyword));
            const gnItems = await safeFetchRSS(gnUrl);
            const gnMapped = gnItems.slice(0, 10).map(item => ({ 
                source: '구글뉴스', title: item.title, link: item.link, snippet: (item.contentSnippet || '').substring(0, 150) 
            }));
            keywordNews = keywordNews.concat(gnMapped);

            for (const rss of config.rssSources) {
                const rssItems = await safeFetchRSS(rss.url);
                // 제목이나 요약 내용에 키워드가 포함된 기사 필터링
                const filtered = rssItems.filter(item => item.title.includes(keyword) || (item.contentSnippet && item.contentSnippet.includes(keyword)));
                const rssMapped = filtered.slice(0, 10).map(item => ({ 
                    source: rss.name, title: item.title, link: item.link, snippet: (item.contentSnippet || '').substring(0, 150) 
                }));
                keywordNews = keywordNews.concat(rssMapped);
            }

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
            process.exit(0); // 수집된 게 없어도 10분 지연 방지를 위해 즉시 종료
        }

        console.log(`\n🚀 총 수집 기사 수: ${totalArticles}개. AI 요약 시작 (키워드별 개별 처리)...`);
        const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
        
        let finalHtmlContent = ""; // ⭐ 자바스크립트가 직접 메일 양식을 조립할 변수

        for (const keyword of config.keywords) {
            const items = groupedNews[keyword];
            if (items.length === 0) continue;

            // 1. 해당 키워드의 뉴스 텍스트만 모음
            let newsData = "";
            items.forEach(n => {
                newsData += `- [${n.source}] ${n.title}\n  (힌트: ${n.snippet})\n`;
            });

            // 2. AI에게는 오직 '요약'만 시킴 (양식 신경쓰지 말라고 통제)
            const prompt = `당신은 핵심만 짚어내는 기업 분석가입니다. 아래는 '${keyword}'에 대한 최신 뉴스입니다.
            조연으로 언급된 기사는 철저히 무시하고, 관련성이 높은 뉴스를 바탕으로 '${keyword}'의 핵심 동향을 정확히 2~3줄로만 요약하세요.
            인사말, 맺음말, 기사 리스트, 제목 등은 절대 쓰지 말고 오직 '요약된 텍스트'만 출력하세요.

            [뉴스 데이터]
            ${newsData}`;
            
            const result = await model.generateContent(prompt);
            const summary = result.response.text().trim();

            // 3. ⭐ 절대 누락되지 않는 자바스크립트 하드코딩 양식 조립 ⭐
            finalHtmlContent += `<h3>&lt;${keyword}&gt;</h3>\n`;
            finalHtmlContent += `<p>${summary}</p>\n`;
            items.forEach(n => {
                finalHtmlContent += `${n.source} / <a href="${n.link}" target="_blank" style="text-decoration:none; color:#1a73e8;">${n.title}</a><br>\n`;
            });
            finalHtmlContent += `<br><br>\n`; // 다음 키워드와의 간격 띄우기
        }

        console.log("✉️ 이메일 발송 시도 중...");
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            host: 'smtp.gmail.com',
            port: 465,
            secure: true,
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_APP_PASS },
            connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 10000
        });

        const info = await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: config.recipientEmail,
            subject: config.emailSubject,
            html: finalHtmlContent // 완벽하게 조립된 HTML 덩어리를 쏩니다.
        });

        console.log("✅ 이메일 발송 완료! MessageId:", info.messageId);
        
        // ⭐ 핵심: 10분 지연 방지 (이메일 발송 후 프로그램 즉시 강제 종료)
        process.exit(0); 

    } catch (error) {
        console.error("❌ 시스템 에러:", error);
        process.exit(1);
    }
}

main();
