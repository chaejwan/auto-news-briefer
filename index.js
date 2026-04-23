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

// 4. 네이버 뉴스 수집 (쌍따옴표 정확히 일치 적용)
async function fetchNaverNews(keyword, timeWindow) {
    const clientId = process.env.NAVER_CLIENT_ID;
    const clientSecret = process.env.NAVER_CLIENT_SECRET;
    if (!clientId || !clientSecret) return [];

    const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent('"' + keyword + '"')}&display=30&sort=date`;
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

// 5. 구글 뉴스 수집
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

            const gnUrl = config.googleNewsApi.replace('{keyword}', encodeURIComponent('"' + keyword + '"')).replace('{window}', windowCode);
            const gnItems = await safeFetchRSS(gnUrl);
            const gnMapped = gnItems
                .filter(item => isRecent(item.pubDate, config.timeWindow))
                .slice(0, 15).map(item => ({ 
                    source: '구글뉴스', title: cleanHtml(item.title), link: item.link, snippet: cleanHtml(item.contentSnippet || '').substring(0, 150), date: formatDate(item.pubDate)
                }));
            keywordNews = keywordNews.concat(gnMapped);

            const naverItems = await fetchNaverNews(keyword, config.timeWindow);
            keywordNews = keywordNews.concat(naverItems);

            // 1차 방어: 똑같은 URL만 가볍게 제거 (복잡한 제목 유사도는 AI에게 넘김)
            const uniqueItems = [];
            keywordNews.forEach(item => {
                const isUrlDuplicate = uniqueItems.some(existing => existing.link === item.link);
                if (!isUrlDuplicate) uniqueItems.push(item);
            });
            
            groupedNews[keyword] = uniqueItems;
            totalArticles += uniqueItems.length;
        }

        if (totalArticles === 0) {
            console.log("수집된 뉴스가 없습니다.");
            process.exit(0);
        }

        console.log(`\n🚀 AI 분석 및 지능형 중복 제거 시작...`);
        const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
        
        let finalHtmlContent = "";

        for (const keyword of config.keywords) {
            const items = groupedNews[keyword];
            if (items.length === 0) continue;

            // ⭐ 기사마다 고유 ID 번호를 부여해서 AI에게 전달
            let newsData = items.map((n, idx) => `[ID: ${idx}] [${n.source}] ${n.title}\n  (내용: ${n.snippet})`).join('\n\n');

            const prompt = `당신은 기업 전략가입니다. 아래는 '${keyword}'에 대한 최신 뉴스입니다.
            
            [지침 - 매우 중요!]
            1. 제공된 [뉴스 데이터]를 꼼꼼히 읽어보세요. '${keyword}'와 무관하거나 유의미한 내용이 없다면 요약에 "현재 수집된 유의미한 관련 기사가 없습니다."라고만 적으세요.
            2. [중복 제거] 여러 언론사가 제목만 바꿔서 보도한 '동일한 사건(예: 특정 정치인의 같은 행보, 한 기업의 단일 보도자료)'은 가장 핵심적인 기사 딱 1개(ID)만 남기고 나머지는 모조리 버리세요.
            3. 중복을 제거하고 살아남은 핵심 기사들의 ID를 고르세요 (최대 5개).
            4. 반드시 아래의 JSON 형식으로만 답변을 출력하세요. 마크다운 기호(\`\`\`)도 쓰지 마세요.
            
            {
              "summary": "핵심 동향 2~3줄 요약 (또는 '관련 기사 없음')",
              "best_ids": [살아남은 기사의 ID 숫자들]
            }
            
            [뉴스 데이터]
            ${newsData}`;
            
            const result = await model.generateContent(prompt);
            const responseText = result.response.text().trim();
            
            // AI가 준 JSON 답변 파싱
            let aiResult;
            try {
                const jsonMatch = responseText.match(/\{[\s\S]*\}/);
                aiResult = JSON.parse(jsonMatch[0]);
            } catch (e) {
                console.error("JSON 파싱 에러:", e);
                aiResult = { summary: "AI 분석 중 오류가 발생했습니다.", best_ids: [] };
            }

            finalHtmlContent += `<h3>&lt;${keyword}&gt;</h3>\n<p>${aiResult.summary}</p>\n`;
            
            // ⭐ '관련 기사가 없습니다'라고 판단한 경우 기사 리스트를 아예 출력하지 않음
            if (!aiResult.summary.includes("유의미한 관련 기사가 없")) {
                // AI가 선택한 진짜 알짜배기 기사들만 추출
                const selectedItems = aiResult.best_ids.map(id => items[id]).filter(item => item !== undefined);
                const displayItems = selectedItems.length > 0 ? selectedItems : items.slice(0, 3);
                
                displayItems.forEach(n => {
                    finalHtmlContent += `${n.source} / ${n.date} / <a href="${n.link}" target="_blank" style="text-decoration:none; color:#1a73e8;">${n.title}</a><br>\n`;
                });
            }
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
