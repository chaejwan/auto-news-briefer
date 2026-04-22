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
    } catch (e) { return []; }
}

async function main() {
    try {
        // 기간 설정값 변환 (예: 25h -> h25, 7d -> d7)
        const windowCode = config.timeWindow.replace(/([0-9]+)([a-zA-Z]+)/, '$2$1');
        console.log(`🚀 뉴스 수집 시작 (검색 기간: ${config.timeWindow} -> 구글 서버 전달값: ${windowCode})`);
        
        const groupedNews = {};
        let totalArticles = 0;

        for (const keyword of config.keywords) {
            console.log(`\n🔍 [키워드: ${keyword}] 수집 중...`);
            let keywordNews = [];

            // 1. 구글 뉴스
            const gnUrl = config.googleNewsApi
                            .replace('{keyword}', encodeURIComponent(keyword))
                            .replace('{window}', windowCode);
            const gnItems = await safeFetchRSS(gnUrl);
            const gnMapped = gnItems.slice(0, 15).map(item => ({ 
                source: '구글뉴스', title: item.title, link: item.link, snippet: (item.contentSnippet || '').substring(0, 150) 
            }));
            keywordNews = keywordNews.concat(gnMapped);
            console.log(`   - 구글뉴스에서 ${gnMapped.length}개 발견`); // ⭐ 로그 복구 완료

            // 2. RSS 소스
            for (const rss of config.rssSources) {
                const rssItems = await safeFetchRSS(rss.url);
                const filtered = rssItems.filter(item => item.title.includes(keyword) || (item.contentSnippet && item.contentSnippet.includes(keyword)));
                const rssMapped = filtered.slice(0, 5).map(item => ({ 
                    source: rss.name, title: item.title, link: item.link, snippet: (item.contentSnippet || '').substring(0, 150) 
                }));
                keywordNews = keywordNews.concat(rssMapped);
                console.log(`   - ${rss.name}에서 ${rssMapped.length}개 발견`); // ⭐ 로그 복구 완료
            }

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

            const prompt = `당신은 핵심만 분석하는 전략 전문가입니다.
            '${keyword}'에 대한 뉴스 리스트입니다.
            
            [지침]
            1. 동일한 사건(예: 특정 주가 등락, 동일한 보도자료)에 대한 중복 기사가 많다면, 이를 하나의 '테마'로 묶어 한 번에 요약하세요.
            2. 단순 시황(주가 상승/하락) 기사가 지배적이라면 이를 아주 짧게 한 줄로 처리하고, 실질적인 기업 활동 소식에 집중하세요.
            3. 인사말 없이 '${keyword}'의 핵심 동향을 2~3줄로만 요약하세요.

            [뉴스 데이터]
            ${newsData}`;
            
            const result = await model.generateContent(prompt);
            const summary = result.response.text().trim();

            finalHtmlContent += `<h3>&lt;${keyword}&gt;</h3>\n<p>${summary}</p>\n`;
            
            items.slice(0, 10).forEach(n => {
                finalHtmlContent += `${n.source} / <a href="${n.link}" target="_blank" style="text-decoration:none; color:#1a73e8;">${n.title}</a><br>\n`;
            });
            finalHtmlContent += `<br><br>\n`;
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

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: config.recipientEmail,
            subject: config.emailSubject,
            html: finalHtmlContent
        });

        console.log("✅ 브리핑 발송 완료!");
        process.exit(0); 

    } catch (error) {
        console.error("❌ 에러:", error);
        process.exit(1);
    }
}

main();
