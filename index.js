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
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    
    return rows.map(row => ({
        sourceType: row.get('SourceType'), // RSS 또는 GoogleNews
        sourceName: row.get('SourceName'),
        queryOrUrl: row.get('URL_or_Keyword'),
        timeWindow: row.get('TimeWindow')   // 1d, 7d 등
    }));
}

// 2. 개별 뉴스 소스에서 데이터 수집
async function fetchNewsFromSource(source) {
    let url = source.queryOrUrl;

    if (source.sourceType === 'GoogleNews') {
        // 시간 범위 파라미터 추가 (1d = qdr:d, 7d = qdr:w)
        const timeParam = source.timeWindow === '1d' ? 'qdr:d' : 'qdr:w';
        url = `https://news.google.com/rss/search?q=${encodeURIComponent(source.queryOrUrl)}&hl=ko&gl=KR&ceid=KR:ko&tbs=${timeParam}`;
    }

    console.log(`📡 [${source.sourceName}] 수집 시작: ${url}`);
    const feed = await parser.parseURL(url);
    return feed.items.slice(0, 3).map(item => ({
        source: source.sourceName,
        title: item.title,
        link: item.link
    }));
}

// 메인 실행 로직
async function main() {
    try {
        const sources = await getSheetData();
        let allNews = [];

        for (const source of sources) {
            try {
                const news = await fetchNewsFromSource(source);
                allNews = allNews.concat(news);
            } catch (e) {
                console.error(`❌ ${source.sourceName} 수집 실패:`, e.message);
            }
        }

        if (allNews.length === 0) return console.log("수집된 뉴스가 없습니다.");

        // AI 요약 및 메일 발송 (이전 로직 활용)
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const newsText = allNews.map((n, i) => `[${n.source}] ${n.title} (${n.link})`).join('\n');
        
        const prompt = `당신은 기업 전략 기획자입니다. 다음 뉴스들을 읽고 오늘의 주요 트렌드를 종합 요약해 주세요. 소스별로 구분하지 말고 전체를 관통하는 핵심 맥락 위주로 3~5줄 요약하고, 그 아래에 관련 기사 링크 리스트를 만들어 주세요.\n\n${newsText}`;
        const result = await model.generateContent(prompt);
        const summary = result.response.text();

        // 이메일 발송
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_APP_PASS }
        });

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: process.env.COMPANY_EMAIL,
            subject: `[종합 브리핑] ${new Date().toLocaleDateString()} 뉴스 리포트`,
            html: summary.replace(/\n/g, '<br>')
        });

        console.log("✅ 모든 소스 취합 및 브리핑 발송 완료!");

    } catch (error) {
        console.error("❌ 시스템 에러:", error);
    }
}

main();
