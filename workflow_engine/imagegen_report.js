#!/usr/bin/env node
/**
 * AI 生成成本月报 (I4.3)
 * 汇总 logs/imagegen_calls.jsonl，输出当月张数/总成本/均价/失败率
 *
 * 用法: node imagegen_report.js [YYYY-MM]
 */

const { getMonthlyCost } = require('./imagegen');

const month = process.argv[2]; // 可选 YYYY-MM
const r = getMonthlyCost(month);

const avg = r.count > 0 ? (r.total / r.count).toFixed(3) : 0;
const total = r.count + r.failures;
const failRate = total > 0 ? ((r.failures / total) * 100).toFixed(1) : 0;

console.log(JSON.stringify({
  month: r.month,
  generated: r.count,
  failures: r.failures,
  fail_rate: `${failRate}%`,
  total_cost: `¥${r.total}`,
  avg_cost: `¥${avg}`,
  budget: `¥${process.env.IMAGEGEN_MONTHLY_BUDGET || '30'}`,
}, null, 2));
