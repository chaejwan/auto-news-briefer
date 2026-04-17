import Parser from 'rss-parser';
import { GoogleGenerativeAI } from '@google/generative-ai';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import fs from 'fs';

// .env 파일이 없어도 시스템 환경 변수를 읽어옵니다.
dotenv.config();
const configData = fs.readFileSync('./config.json', 'utf8');
const config = JSON.parse(configData);

const parser = new Parser();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function fetchNews() {
    console.log("📰 RSS 피드에서 뉴스를 수집합니다...");
    const keyword = config.targetKeywords[0]; 
    const feedUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=ko&gl=KR&ceid=KR:ko`;
    const feed = await parser.parseURL(feedUrl);
    
    return feed.items.slice(0, 5).map(item => ({
        title: item.title,
        link: item.link,
        content: item.contentSnippet || item.content || ''
    }));
}

async function summarizeNews(newsItems) {
    console.log("🧠 Gemini 모델이 뉴스를 분석하고 요약합니다...");
    const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" }); 
    const newsText = newsItems.map((n, i) => `[${i+1}] 제목: ${n.title}\n내용: ${n.content}\n링크: ${n.link}`).join('\n\n');
    
    const prompt = `
    ${config.llmPrompt}
    
    [뉴스 데이터]
    ${newsText}
    `;
    const result = await model.generateContent(prompt);
    return result.response.text();
}

async function sendEmail(summaryText) {
    console.log("✉️ 요약된 브리핑을 이메일로 발송합니다...");
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_APP_PASS 
        }
    });

    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: process.env.COMPANY_EMAIL,
        subject: config.emailSubject,
        html: summaryText.replace(/\n/g, '<br>') 
    };

    await transporter.sendMail(mailOptions);
    console.log("✅ 이메일 발송 완료!");
}

async function main() {
    try {
        const news = await fetchNews();
        if (news.length === 0) {
            console.log("수집된 뉴스가 없습니다.");
            return;
        }
        const summary = await summarizeNews(news);
        await sendEmail(summary);
    } catch (error) {
        console.error("❌ 에러 발생:", error);
    }
}

main();
