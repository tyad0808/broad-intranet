// 통계 화면 (관리자만): 매출 탭 · 직원 탭
const express = require('express');
const { salesReport } = require('../stats');
const { periodRange } = require('../retention');

const kstDay = (d = new Date()) => new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// 빠른 기간: 이번 달 · 지난달 · 최근 7일 · 최근 30일 · 최근 3개월 · 올해
function quickRanges(now = new Date()) {
  const today = kstDay(now);
  const [y, m] = today.split('-').map(Number);
  const first = (yy, mm) => new Date(Date.UTC(yy, mm - 1, 1)).toISOString().slice(0, 10);
  return [
    { label: '오늘', from: today, to: today },
    { label: '어제', from: addDays(today, -1), to: addDays(today, -1) },
    { label: '이번 달', from: first(y, m), to: today },
    { label: '지난달', from: first(y, m - 1), to: new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10) },
    { label: '최근 7일', from: addDays(today, -6), to: today },
    { label: '최근 30일', from: addDays(today, -29), to: today },
    { label: '최근 3개월', from: first(y, m - 2), to: today },
    { label: '올해', from: `${y}-01-01`, to: today },
  ];
}

function statsRoutes(db, { staffReport = null } = {}) {
  const router = express.Router();
  router.get('/', (req, res) => {
    const quick = quickRanges();
    const thisMonth = quick.find(q => q.label === '이번 달');
    const picked = periodRange(req.query.from, req.query.to);
    // 기본: 이번 달. 한쪽만 고르면 그날부터 오늘까지 / 처음부터 그날까지는 너무 길어서 그달 1일부터
    const fromDay = picked && picked.from ? picked.from : picked && picked.to ? `${picked.to.slice(0, 8)}01` : thisMonth.from;
    const toDay = picked && picked.to ? picked.to : kstDay();
    const tab = req.query.tab === 'staff' && staffReport ? 'staff' : 'sales';
    res.render('stats', {
      title: '통계', navSection: 'stats', tab,
      fromDay, toDay, quick,
      report: tab === 'sales' ? salesReport(db, fromDay, toDay) : null,
      staff: tab === 'staff' ? staffReport(db, fromDay, toDay) : null,
    });
  });
  return router;
}

module.exports = { statsRoutes, quickRanges };
