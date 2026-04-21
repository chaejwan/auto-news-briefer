import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import Parser from 'rss-parser';
import { GoogleGenerativeAI } from '@google/generative-ai';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();
const parser = new Parser();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 1. 구글 스프레드시트 읽기 함수
async function getSheetData() {
    const serviceAccountAuth = new JWT({
        email: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY).client_email,
        key: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY).private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const rows = await doc.sheetsByIndex[0].getRows();
    
    return rows.map(row => ({
        sourceType: row.get('SourceType'),
        sourceName: row.get('SourceName'),
        queryOrUrl: row.get('URL_or_Keyword'),
        timeWindow: row.get('TimeWindow') || '1d'
    }));
}

// 2. 데이터 수집 및 1차 필터링 함수
async function fetchAndFilterNews(source) {
    let url = source.queryOrUrl;

    if (source.sourceType === 'GoogleNews') {
        const timeParam = source.timeWindow === '1d' ? 'qdr:d' : 'qdr:w';
        url = `https://news.google.com/rss/search?q=${encodeURIComponent(source.queryOrUrl)}&hl=ko&gl=KR&ceid=KR:ko&tbs=${timeParam}`;
    }

    console.log(`📡 [${source.sourceName}] 데이터 수집 중...`);
    const feed = await parser.parseURL(url);
    let items = feed.items;

    // 시트에 'FilterKeywords'가 설정된 경우 필터링
    if (source.sourceType === 'RSS' && source.FilterKeywords) {
        const filterKeywords = source.FilterKeywords.split(',').map(k => k.trim());
        items = items.filter(item => 
            filterKeywords.some(kw => item.title.includes(kw))
        );
        console.log(`✨ [${source.sourceName}] 필터링 완료: ${feed.items.length}개 중 ${items.length}개 선정`);
    }

    return items.map(item => ({
        source: source.sourceName,
        title: item.title,
        link: item.link
    }));
}

// 3. 메인 실행 로직
async function main() {
    try {
        const sources = await getSheetData();
        let combinedNews = [];

        // 1단계: 시트의 모든 소스에서 데이터 수집
        for (const source of sources) {
            try {
                const news = await fetchAndFilterNews(source);
                combinedNews = combinedNews.concat(news);
            } catch (e) {
                console.error(`❌ ${source.sourceName} 오류:`, e.message);
            }
        }

        // 2단계: 중복 제거 로직
        const uniqueNewsMap = new Map();
        combinedNews.forEach(item => {
            const cleanUrl = item.link.split('?')[0];
            if (!uniqueNewsMap.has(cleanUrl)) {
                uniqueNewsMap.set(cleanUrl, item);
            }
        });

        // ⭐ 3단계: 기사 갯수 제한 (상위 20개만 자르기) ⭐
        const finalNewsList = Array.from(uniqueNewsMap.values()).slice(0, 20);

        console.log(`🚀 최종 요약 대상 기사: ${finalNewsList.length}개 (상위 20개 커트 완료)`);

        if (finalNewsList.length === 0) {
            return console.log("수집된 뉴스가 없습니다.");
        }

        // 4단계: Gemini AI 요약
        const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
        const newsText = finalNewsList.map((n, i) => `[${n.source}] ${n.title}\n${n.link}`).join('\n\n');
        
        const prompt = `당신은 기업 전략 기획자입니다. 다음 뉴스 리스트를 분석하여 핵심 트렌드를 요약해 주세요. 중복된 내용은 하나로 합치고, 가장 중요한 소식부터 배열해 주세요.\n\n${newsText}`;
        const result = await model.generateContent(prompt);
        const summary = result.response.text();

        // 5단계: 이메일 발송
        console.log("✉️ 이메일 발송 시도 중...");
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            host: 'smtp.gmail.com',
            port: 465,
            secure: true,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_APP_PASS 
            },
            connectionTimeout: 10000, 
            greetingTimeout: 10000,
            socketTimeout: 10000
        });

        const info = await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: process.env.COMPANY_EMAIL,
            subject: `[종합 브리핑] ${new Date().toLocaleDateString()} 뉴스 리포트`,
            html: summary.replace(/\n/g, '<br>')
        });

        console.log("✅ 이메일 발송 완료! MessageId:", info.messageId);

    } catch (error) {
        console.error("❌ 시스템 에러:", error);
    }
}

main();
