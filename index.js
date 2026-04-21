import fs from 'fs';
import Parser from 'rss-parser';
import { GoogleGenerativeAI } from '@google/generative-ai';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();
const parser = new Parser();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 1. 환경 설정 파일 읽기
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

// 개별 피드 수집용 안전한 함수 (에러 발생 시 프로그램이 죽지 않도록 방어)
async function safeFetchRSS(url) {
    try {
        const feed = await parser.parseURL(url);
        return feed.items;
    } catch (e) {
        console.error(`❌ 수집 실패 (${url}):`, e.message);
        return [];
    }
}

async function main() {
    try {
        console.log("🚀 키워드 중심 뉴스 수집을 시작합니다...");
        const groupedNews = {};

        // 2. 키워드별 데이터 수집 로직
        for (const keyword of config.keywords) {
            console.log(`\n🔍 [키워드: ${keyword}] 수집 중...`);
            let keywordNews = [];

            // A. 구글 뉴스 (API 검색)
            const gnUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=ko&gl=KR&ceid=KR:ko&tbs=qdr:d`;
            const gnItems = await safeFetchRSS(gnUrl);
            const gnMapped = gnItems.slice(0, 10).map(item => ({ source: '구글뉴스', title: item.title, link: item.link }));
            keywordNews = keywordNews.concat(gnMapped);
            console.log(`   - 구글뉴스에서 ${gnMapped.length}개 발견 (최대 10개 제한)`);

            // B. 등록된 언론사 RSS 뒤지기 (형광펜 필터링)
            for (const rss of config.rssSources) {
                const rssItems = await safeFetchRSS(rss.url);
                // 제목에 키워드가 포함된 기사만 필터링
                const filtered = rssItems.filter(item => item.title.includes(keyword));
                const rssMapped = filtered.slice(0, 10).map(item => ({ source: rss.name, title: item.title, link: item.link }));
                keywordNews = keywordNews.concat(rssMapped);
                console.log(`   - ${rss.name}에서 ${rssMapped.length}개 발견 (최대 10개 제한)`);
            }

            // C. 중복 제거 (URL 기준)
            const uniqueMap = new Map();
            keywordNews.forEach(item => {
                const cleanUrl = item.link.split('?')[0];
                if (!uniqueMap.has(cleanUrl)) uniqueMap.set(cleanUrl, item);
            });
            
            groupedNews[keyword] = Array.from(uniqueMap.values());
        }

        // 3. AI에게 전달할 텍스트 조립 (키워드 단위로 묶음)
        let promptData = "";
        let totalArticles = 0;
        
        for (const keyword of config.keywords) {
            const items = groupedNews[keyword];
            if (items.length > 0) {
                promptData += `\n\n### 키워드: ${keyword} ###\n`;
                items.forEach(n => {
                    promptData += `- [${n.source}] ${n.title}\n  ${n.link}\n`;
                });
                totalArticles += items.length;
            }
        }

        if (totalArticles === 0) return console.log("수집된 뉴스가 없습니다.");
        console.log(`\n🚀 총 수집 기사 수: ${totalArticles}개. AI 요약 시작...`);

        // 4. Gemini 3.1 Flash Lite 적용 및 프롬프트 생성
        const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
        const prompt = `
        당신은 기업 전략 기획자입니다. 제공된 뉴스 데이터를 바탕으로 보고서를 작성하세요.
        반드시 '키워드'별로 섹션을 나누어 작성하고, 기사 링크들을 목록 형태로 달아주세요.
        
        [특별 요약 지침]
        ${config.summaryInstruction}
        
        [뉴스 데이터]
        ${promptData}
        `;
        
        const result = await model.generateContent(prompt);
        const summary = result.response.text();

        // 5. 이메일 발송
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
            to: process.env.COMPANY_EMAIL,
            subject: config.emailSubject,
            html: summary.replace(/\n/g, '<br>')
        });

        console.log("✅ 이메일 발송 완료! MessageId:", info.messageId);

    } catch (error) {
        console.error("❌ 시스템 에러:", error);
    }
}

main();
