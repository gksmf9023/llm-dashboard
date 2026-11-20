#!/usr/bin/env node
/**
 * OpenRouter 공개 모델 목록 API(키 불필요)에서 모델 정보를 수집해
 * data/models.json, data/meta.json 을 갱신한다.
 *
 * - 외부 패키지 없음 (Node.js 20+ 내장 fetch 사용)
 * - 안전장치: 수집 실패 / 응답 구조 이상 / 모델 수 급감 시
 *   기존 파일을 건드리지 않고 exit code 1 로 종료 → 워크플로 실패 처리
 * - 모델 데이터가 이전과 같으면 아무 파일도 쓰지 않음 → 불필요한 커밋 없음
 * - `:batch`, `:free` 같은 변형은 본 모델 행의 variants 로 묶음
 *
 * 사용법:
 *   node scripts/fetch-models.mjs                 # API에서 수집
 *   node scripts/fetch-models.mjs --input x.json  # 로컬 파일(OpenRouter 응답 형식)로 테스트
 *   node scripts/fetch-models.mjs --dry-run       # 결과만 출력, 파일 쓰지 않음
 *   node scripts/fetch-models.mjs --sample        # meta.json에 샘플 데이터 표시(isSample)
 *   node scripts/fetch-models.mjs --reprocess     # API 호출 없이 현재 models.json을 새 규칙으로 재정리
 *
 * 환경 변수(선택):
 *   MIN_MODELS       필터링 후 최소 모델 수 (기본 30)
 *   MAX_DROP_RATIO   이전 대비 허용 감소 비율 (기본 0.3 = 30% 넘게 줄면 실패)
 *   MIN_PROVIDERS    최소 제공사 수 (기본 5)
 */

import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const MODELS_FILE = path.join(DATA_DIR, 'models.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');

const API_URL = 'https://openrouter.ai/api/v1/models';
const SOURCE = {
  name: 'OpenRouter Models API',
  url: API_URL,
  docs: 'https://openrouter.ai/docs/api-reference/models/get-models',
  note: '가격은 OpenRouter 기준이며 제공사 공식 가격과 다를 수 있습니다.',
};

const MIN_MODELS = Number(process.env.MIN_MODELS ?? 30);
const MAX_DROP_RATIO = Number(process.env.MAX_DROP_RATIO ?? 0.3);
const MIN_PROVIDERS = Number(process.env.MIN_PROVIDERS ?? 5);
const MIN_RAW_MODELS = 50; // 필터 전 API 응답 자체가 이보다 적으면 비정상
const MAX_INVALID_RATIO = 0.2; // 대상 모델 중 가격/형식 이상 비율 한도

// OpenRouter 모델 id 접두사 → 표시용 제공사
const PROVIDERS = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  'meta-llama': 'Meta',
  'x-ai': 'xAI',
  deepseek: 'DeepSeek',
  mistralai: 'Mistral',
  qwen: 'Qwen (Alibaba)',
  alibaba: 'Qwen (Alibaba)',
};

const args = new Set(process.argv.slice(2));
const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};

function fail(msg) {
  console.error(`::error::${msg}`);
  console.error('기존 데이터 파일은 변경하지 않았습니다.');
  process.exit(1);
}

async function fetchWithRetry(url, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'llm-dashboard-data-bot' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      console.warn(`요청 실패 (${i}/${tries}): ${err.message}`);
      if (i < tries) await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  throw lastErr;
}

/** USD/token 문자열 → USD/1M tokens 숫자. 음수(변동 가격 등)나 이상값은 null */
function perMillion(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Number((n * 1e6).toFixed(4));
}

function toKstDate(unixSec) {
  if (!Number.isFinite(unixSec) || unixSec <= 0) return null;
  return new Date(unixSec * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function nowKst() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const iso = d.toISOString().slice(0, 19) + '+09:00';
  const display = `${iso.slice(0, 10)} ${iso.slice(11, 16)} KST`;
  return { iso, display };
}

function shortDescription(text, max = 180) {
  if (!text) return '';
  const plain = String(text)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // 마크다운 링크
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const firstSentence = plain.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? plain;
  const s = firstSentence.length <= max ? firstSentence : plain;
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

function normalize(raw) {
  if (!raw || !Array.isArray(raw.data)) fail('API 응답에 data 배열이 없습니다. 응답 구조가 바뀌었을 수 있습니다.');
  if (raw.data.length < MIN_RAW_MODELS) fail(`API 응답 모델 수가 비정상적으로 적습니다: ${raw.data.length}개 (최소 ${MIN_RAW_MODELS})`);

  let targets = 0;
  let invalid = 0;
  const rows = [];

  for (const m of raw.data) {
    if (typeof m?.id !== 'string') continue;
    const prefix = m.id.split('/')[0];
    const provider = PROVIDERS[prefix];
    if (!provider) continue;

    targets++;
    const inputPrice = perMillion(m.pricing?.prompt);
    const outputPrice = perMillion(m.pricing?.completion);
    if (inputPrice === null || outputPrice === null) {
      invalid++;
      continue;
    }

    const name = String(m.name ?? m.id).replace(/^[^:]{1,40}:\s*/, '');
    rows.push({
      id: m.id,
      name,
      provider,
      inputPrice,
      outputPrice,
      contextLength: Number.isFinite(m.context_length) ? m.context_length : null,
      maxOutputTokens: Number.isFinite(m.top_provider?.max_completion_tokens) ? m.top_provider.max_completion_tokens : null,
      created: toKstDate(m.created),
      modality: m.architecture?.modality ?? null,
      description: shortDescription(m.description),
    });
  }

  if (targets > 0 && invalid / targets > MAX_INVALID_RATIO) {
    fail(`가격 정보가 비정상인 모델 비율이 너무 높습니다: ${invalid}/${targets}`);
  }

  return groupVariants(rows);
}

/**
 * OpenRouter는 같은 모델의 변형을 `<id>:<변형>` 으로 따로 등록한다 (예: `:batch`, `:free`).
 * 본 모델이 있으면 변형은 별도 행으로 두지 않고 본 모델의 variants 배열에 가격만 붙인다.
 * 본 모델 없이 변형만 있으면 그 변형을 그대로 한 행으로 둔다.
 */
function groupVariants(rows) {
  const byId = new Map();
  for (const r of rows) {
    if (!r.id.includes(':')) {
      const { variants, hasFreeVariant, ...base } = r; // 이전 형식 필드 제거
      byId.set(r.id, { ...base, variants: [] });
    }
  }
  const models = [...byId.values()];
  for (const r of rows) {
    if (!r.id.includes(':')) continue;
    const [baseId, type] = r.id.split(':');
    const base = byId.get(baseId);
    if (base) {
      base.variants.push({ type, id: r.id, inputPrice: r.inputPrice, outputPrice: r.outputPrice });
    } else {
      const { variants, hasFreeVariant, ...orphan } = r;
      models.push({ ...orphan, variants: [] });
    }
  }
  for (const m of models) {
    m.variants.sort((a, b) => a.type.localeCompare(b.type));
    if (!m.variants.length) delete m.variants;
  }
  models.sort((a, b) => (b.created ?? '').localeCompare(a.created ?? '') || a.id.localeCompare(b.id));
  return models;
}

async function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeAtomic(file, obj) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

async function main() {
  const inputFile = argValue('--input');
  let raw;
  try {
    if (inputFile) raw = JSON.parse(await readFile(inputFile, 'utf8'));
    else if (!args.has('--reprocess')) raw = await fetchWithRetry(API_URL);
  } catch (err) {
    fail(`모델 목록 수집 실패: ${err.message}`);
  }

  // --reprocess: API 호출 없이 현재 data/models.json 을 새 규칙(변형 묶기 등)으로 다시 정리
  const models = args.has('--reprocess')
    ? groupVariants((await readJson(MODELS_FILE))?.models ?? [])
    : normalize(raw);

  // ---- 안전장치 ----
  if (models.length < MIN_MODELS) fail(`필터링된 모델 수가 너무 적습니다: ${models.length}개 (최소 ${MIN_MODELS})`);

  const providerCounts = {};
  for (const m of models) providerCounts[m.provider] = (providerCounts[m.provider] ?? 0) + 1;
  const sortedCounts = Object.fromEntries(Object.entries(providerCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  if (Object.keys(providerCounts).length < MIN_PROVIDERS) {
    fail(`제공사 수가 너무 적습니다: ${Object.keys(providerCounts).join(', ')}`);
  }

  const prev = await readJson(MODELS_FILE);
  const prevMeta = await readJson(META_FILE);
  const prevCount = Array.isArray(prev?.models) ? prev.models.length : 0;
  if (prevCount > 0 && !prevMeta?.isSample && !args.has('--reprocess') && models.length < prevCount * (1 - MAX_DROP_RATIO)) {
    fail(`모델 수가 급감했습니다: ${prevCount} → ${models.length} (허용 감소율 ${MAX_DROP_RATIO * 100}%)`);
  }

  const output = { source: SOURCE.url, count: models.length, models };
  const isSample = args.has('--sample');
  const unchanged = JSON.stringify(prev) === JSON.stringify(output) && Boolean(prevMeta?.isSample) === isSample;

  console.log(`수집 완료: ${models.length}개 모델`);
  console.table(sortedCounts);

  if (args.has('--dry-run')) {
    console.log('--dry-run: 파일을 쓰지 않습니다.');
    return;
  }
  if (unchanged) {
    console.log('변경 사항 없음: 파일을 쓰지 않습니다.');
    return;
  }

  // --reprocess 는 새로 수집한 것이 아니므로 마지막 수집 시각을 유지
  const t = args.has('--reprocess') && prevMeta?.lastUpdated
    ? { iso: prevMeta.lastUpdated, display: prevMeta.lastUpdatedKST }
    : nowKst();
  const meta = {
    lastUpdated: t.iso,
    lastUpdatedKST: t.display,
    isSample,
    modelCount: models.length,
    providerCounts: sortedCounts,
    sources: [SOURCE],
  };

  await writeAtomic(MODELS_FILE, output);
  await writeAtomic(META_FILE, meta);
  console.log(`저장 완료: data/models.json, data/meta.json (${t.display})`);
}

main().catch((err) => fail(err.stack || String(err)));
