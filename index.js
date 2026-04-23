import fs from 'fs';
import Parser from 'rss-parser';
import { GoogleGenerativeAI } from '@google/generative-ai';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();
const parser = new Parser();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

// 1. 날짜 변환 함수 (YY-MM-DD)
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

// 4. 네이버 뉴스 수집 (관대한 수집, 최대 30개)
async function fetchNaverNews(keyword, timeWindow) {
    const clientId = process.env.NAVER_CLIENT_ID;
    const clientSecret = process.env.NAVER_CLIENT_SECRET;
    if (!clientId || !clientSecret) return [];

    // 쌍따옴표를 유지하여 정확도를 높이되, 제목 검사는 하지 않고 모두 수집
    const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent('"' + keyword + '"')}&display=30&sort=date`;
    try {
        const response = await fetch(url, {
            headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret }
        });
        const data = await response.json();
        if (!data.items) return [];

        return data.items
            .filter(item => isRecent(item.pubDate, timeWindow))
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

        // [1단계 & 1.5단계] 관대한 수집 및 URL 중복 제거
        for (const keyword of config.keywords) {
            console.log(`\n🔍 [키워드: ${keyword}] 모수 수집 중...`);
            let keywordNews = [];

            const gnUrl = config.googleNewsApi.replace('{keyword}', encodeURIComponent('"' + keyword + '"')).replace('{window}', windowCode);
            const gnItems = await safeFetchRSS(gnUrl);
            const gnMapped = gnItems
                .filter(item => isRecent(item.pubDate, config.timeWindow))
                .slice(0, 20).map(item => ({ 
                    source: '구글뉴스', title: cleanHtml(item.title), link: item.link, snippet: cleanHtml(item.contentSnippet || '').substring(0, 150), date: formatDate(item.pubDate)
                }));
            keywordNews = keywordNews.concat(gnMapped);

            const naverItems = await fetchNaverNews(keyword, config.timeWindow);
            keywordNews = keywordNews.concat(naverItems);

            // 1.5단계: 100% 동일한 URL만 가볍게 제거 (토큰 최적화)
            const uniqueItems = [];
            keywordNews.forEach(item => {
                const isUrlDuplicate = uniqueItems.some(existing => existing.link === item.link);
                if (!isUrlDuplicate) uniqueItems.push(item);
            });
            
            // 토큰 한도 방지를 위해 최대 상위 25개까지만 AI에게 전달
            groupedNews[keyword] = uniqueItems.slice(0, 25);
            totalArticles += groupedNews[keyword].length;
            console.log(`   - 1차 수집 완료: ${groupedNews[keyword].length}개 기사 확보 (AI 심사 대기)`);
        }

        if (totalArticles === 0) {
            console.log("수집된 뉴스가 없습니다.");
            process.exit(0);
        }

        console.log(`\n🚀 [2단계 & 3단계] AI 심층 면접 및 거시적 요약 시작...`);
        const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
        
        let finalHtmlContent = "";

        for (const keyword of config.keywords) {
            const items = groupedNews[keyword];
            if (items.length === 0) continue;

            // 기사 번호(ID), 제목, 요약문을 AI에게 전달
            let newsData = items.map((n, idx) => `[ID: ${idx}] [${n.source}] ${n.title}\n  (내용: ${n.snippet})`).join('\n\n');

            // ⭐ 핵심 로직: 주제 판별(Triage) + 지능형 중복제거 + 거시적 요약을 한 번에 지시하는 프롬프트
            const prompt = `당신은 최고인사책임자(CHRO)이자 기업 전략가입니다. 아래는 '${keyword}' 키워드로 1차 수집된 기사 목록입니다.

            [엄격한 업무 지침 - 반드시 순서대로 수행하세요]
            1. 주제 심사 (Triage): 각 기사(ID)의 '메인 주제'를 파악하세요. 범죄 사건, 정치권 가십, 단순 사고 기사이거나, '${keyword}'가 스쳐 지나가듯 단편적으로만 언급된 기사는 모조리 탈락(제외)시키세요. 기업 경영, 인사/노무, 조직 문화, 비즈니스 전략과 '직접적인' 관련이 있는 기사만 합격시키세요.
            2. 지능형 중복 제거: 합격한 기사들 중, 제목이나 표현이 달라도 "결국 같은 기업의 동일한 보도자료나 행사/사건"을 다룬 기사들은 가장 내용이 충실한 1개의 ID만 남기고 중복으로 처리하여 버리세요.
            3. 거시적 요약 (Macro-Summary): 1번과 2번의 독한 심사를 통과하여 최종 살아남은 알짜 기사들만 바탕으로 전체적인 흐름(Main Idea)을 2~3줄로 거시적으로 요약하세요. 지엽적인 단어나 곁가지 내용(예: 특정 노조 파업 기사에서 지나가듯 언급된 타사 노조 이름 등)에 집착하여 주객전도된 요약을 절대 하지 마세요.
            4. 살아남은 기사가 단 하나도 없다면, 억지로 요약하지 말고 오직 "현재 수집된 유의미한 관련 기사가 없습니다."라고만 출력하세요.

            [출력 형식]
            반드시 아래의 순수한 JSON 형식으로만 답하세요 (마크다운 \`\`\` 기호 금지).
            {
              "summary": "거시적 2~3줄 요약 (또는 '관련 기사 없음')",
              "best_ids": [살아남은 최종 알짜 기사의 ID 숫자들 (최대 5개)]
            }
            
            [뉴스 데이터]
            ${newsData}`;
            
            const result = await model.generateContent(prompt);
            const responseText = result.response.text().trim();
            
            let aiResult;
            try {
                const jsonMatch = responseText.match(/\{[\s\S]*\}/);
                aiResult = JSON.parse(jsonMatch[0]);
            } catch (e) {
                console.error("JSON 파싱 에러:", e);
                aiResult = { summary: "AI 분석 중 오류가 발생했습니다.", best_ids: [] };
            }

            finalHtmlContent += `<h3>&lt;${keyword}&gt;</h3>\n<p>${aiResult.summary}</p>\n`;
            
            // ⭐ [4단계] 브리핑 조립: 살아남은 기사만 노출
            if (!aiResult.summary.includes("유의미한 관련 기사가 없")) {
                const selectedItems = aiResult.best_ids.map(id => items[id]).filter(item => item !== undefined);
                
                selectedItems.forEach(n => {
                    finalHtmlContent += `${n.source} / ${n.date} / <a href="${n.link}" target="_blank" style="text-decoration:none; color:#1a73e8;">${n.title}</a><br>\n`;
                });
            }
            finalHtmlContent += `<br><br>\n`;
        }

        // 이메일 발송 모듈
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
