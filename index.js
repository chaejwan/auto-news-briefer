import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import Parser from 'rss-parser';
import { GoogleGenerativeAI } from '@google/generative-ai';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();
const parser = new Parser();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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

async function fetchAndFilterNews(source) {
    let url = source.queryOrUrl;
    let keywords = [];

    // GoogleNews인 경우 검색 쿼리로 사용, RSS인 경우 필터링 키워드로 분리
    if (source.sourceType === 'GoogleNews') {
        const timeParam = source.timeWindow === '1d' ? 'qdr:d' : 'qdr:w';
        url = `https://news.google.com/rss/search?q=${encodeURIComponent(source.queryOrUrl)}&hl=ko&gl=KR&ceid=KR:ko&tbs=${timeParam}`;
    } else if (source.sourceType === 'RSS') {
        // 예: "반도체, HBM, 삼성" 처럼 콤마로 구분된 키워드가 있다면 추출
        // (참고: 시트 구조상 URL 뒤에 키워드를 넣기 어려우므로, 별도 열을 만들거나 규칙을 정해야 함)
        // 여기서는 편의상 시트의 SourceName에 키워드가 포함되어 있다고 가정하거나 
        // 특정 키워드 리스트를 전역으로 관리할 수 있습니다.
    }

    console.log(`📡 [${source.sourceName}] 데이터 수집 중...`);
    const feed = await parser.parseURL(url);
    let items = feed.items;

    // RSS 타입일 때만 키워드 필터링 적용 (제목에 키워드가 포함된 경우만 남김)
    // 여기서는 예시로 '한화오션', '삼성중공업', 'SK하이닉스'를 필터 키워드로 사용
    const filterKeywords = ['한화오션', '삼성중공업', 'SK하이닉스', '반도체', '조선']; 
    
    if (source.sourceType === 'RSS') {
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

async function main() {
    try {
        const sources = await getSheetData();
        let combinedNews = [];

        // 1. 모든 소스에서 데이터 수집 및 1차 필터링
        for (const source of sources) {
            try {
                const news = await fetchAndFilterNews(source);
                combinedNews = combinedNews.concat(news);
            } catch (e) {
                console.error(`❌ ${source.sourceName} 오류:`, e.message);
            }
        }

        // 2. 중복 제거 (URL 기준)
        const uniqueNewsMap = new Map();
        combinedNews.forEach(item => {
            // URL 주소의 핵심 부분만 추출하여 중복 체크 (파라미터 제거 등)
            const cleanUrl = item.link.split('?')[0];
            if (!uniqueNewsMap.has(cleanUrl)) {
                uniqueNewsMap.set(cleanUrl, item);
            }
        });
        const finalNewsList = Array.from(uniqueNewsMap.values());

        console.log(`🚀 최종 요약 대상 기사: ${finalNewsList.length}개 (중복 제거 완료)`);

        if (finalNewsList.length === 0) return;

        // 3. AI 요약 및 메일 발송 (이전 로직 동일)
        const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-light-preview" });
        const newsText = finalNewsList.map((n, i) => `[${n.source}] ${n.title}\n${n.link}`).join('\n\n');
        
        const prompt = `당신은 기업 전략 기획자입니다. 다음 뉴스 리스트를 분석하여 핵심 트렌드를 요약해 주세요. 중복된 내용은 하나로 합치고, 가장 중요한 소식부터 배열해 주세요.\n\n${newsText}`;
        const result = await model.generateContent(prompt);
        
        // (이후 nodemailer 발송 로직...)
        console.log("✅ 브리핑 발송 완료!");

    } catch (error) {
        console.error("❌ 시스템 에러:", error);
    }
}

main();
