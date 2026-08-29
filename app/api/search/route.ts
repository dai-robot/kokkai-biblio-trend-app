import { NextResponse } from 'next/server';

type SearchMode = 'both' | 'bibliography' | 'proceedings';
type SourceId = 'bibliography' | 'proceedings';

type SearchRequest = {
  mode?: SearchMode;
  queryGroup?: {
    label?: string;
    terms?: string[];
  };
  yearRange?: {
    from?: number;
    to?: number;
  };
};

type TermResult = {
  term: string;
  firstYear: number | null;
  total: number;
  yearly: { year: number; count: number }[];
  errors: number;
};

type CachedCount = {
  count: number;
  expiresAt: number;
};

export const maxDuration = 60;

const MAX_BIBLIOGRAPHY_YEARS = 5;
const MAX_PROCEEDINGS_YEARS = 90;

const SOURCE_LABELS: Record<SourceId, { label: string; unit: string }> = {
  bibliography: {
    label: '国立国会図書館の書誌データ',
    unit: '本のタイトルに語が含まれる書誌レコード件数',
  },
  proceedings: {
    label: '国会議事録',
    unit: '本文に語が含まれる発言単位の検索ヒット件数',
  },
};

const officialSources = [
  {
    title: 'NDLサーチ API仕様の概要',
    url: 'https://ndlsearch.ndl.go.jp/help/api/specifications',
  },
  {
    title: 'NDLサーチ APIのご利用について',
    url: 'https://ndlsearch.ndl.go.jp/help/api',
  },
  {
    title: '国会会議録検索システム 検索用API仕様',
    url: 'https://kokkai.ndl.go.jp/api.html',
  },
];

const notes = [
  'NDLサーチはSRU APIを使用し、title="語" と出版年の from/until で年別件数を取得します。',
  '国会会議録は speech APIを使用し、any=語 と会議開催日の from/until で年別件数を取得します。',
  '外部APIへのアクセスは多重化せず、1語ずつ年別に逐次集計します。取得結果はサーバー側で一定期間キャッシュします。',
  'NDLサーチは年によって応答時間が大きく変動するため、NDLを含む検索は5年以内に制限しています。',
  'NDLサーチは利用目的・データ提供機関により申請や許諾が必要な場合があります。継続利用時は公式の利用申請フォーム確認が必要です。',
  '国会会議録APIは手続き不要と案内されていますが、短時間の大量アクセスは避ける必要があります。',
];

const countCache = new Map<string, CachedCount>();
const pendingCountRequests = new Map<string, Promise<number>>();
const COUNT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as SearchRequest;
    const mode = body.mode ?? 'both';
    const terms = normalizeTerms(body.queryGroup?.terms ?? []);
    const label = terms[0] || '検索語';
    const from = Number(body.yearRange?.from ?? 2000);
    const to = Number(body.yearRange?.to ?? new Date().getFullYear());

    if (!['both', 'bibliography', 'proceedings'].includes(mode)) {
      return NextResponse.json(
        { error: '検索対象の指定が不正です。' },
        { status: 400 },
      );
    }
    if (terms.length === 0) {
      return NextResponse.json(
        { error: '検索語を入力してください。' },
        { status: 400 },
      );
    }
    if (terms.length !== 1) {
      return NextResponse.json(
        {
          error: '検索語は1語だけ指定してください。',
        },
        { status: 400 },
      );
    }
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 1948 ||
      to < from
    ) {
      return NextResponse.json(
        { error: '年範囲の指定が不正です。' },
        { status: 400 },
      );
    }
    const includesBibliography = mode === 'both' || mode === 'bibliography';
    const yearSpan = to - from + 1;
    if (includesBibliography && yearSpan > MAX_BIBLIOGRAPHY_YEARS) {
      return NextResponse.json(
        {
          error:
            `NDL書誌を含む検索は、API負荷と応答時間を考慮して${MAX_BIBLIOGRAPHY_YEARS}年以内にしてください。`,
        },
        { status: 400 },
      );
    }
    if (!includesBibliography && yearSpan > MAX_PROCEEDINGS_YEARS) {
      return NextResponse.json(
        {
          error:
            `国会議事録のみの検索は、一度の検索範囲を${MAX_PROCEEDINGS_YEARS}年以内にしてください。`,
        },
        { status: 400 },
      );
    }

    const selectedSources: SourceId[] =
      mode === 'both' ? ['bibliography', 'proceedings'] : [mode];

    const sources = [];
    for (const source of selectedSources) {
      const termsResult = await buildTermResults(source, terms, from, to);
      const yearly = aggregateYearly(termsResult, from, to);
      const total = yearly.reduce((sum, item) => sum + item.count, 0);
      const firstYear = yearly.find((item) => item.count > 0)?.year ?? null;
      const failedYears = termsResult.reduce(
        (sum, term) => sum + term.errors,
        0,
      );

      sources.push({
        source,
        label: SOURCE_LABELS[source].label,
        unit: SOURCE_LABELS[source].unit,
        firstYear,
        total: Math.max(0, total),
        yearly,
        terms: termsResult.map((term) => ({
          ...term,
          total: Math.max(0, term.total),
        })),
        status: failedYears > 0 ? 'partial' : 'ok',
        error:
          failedYears > 0
            ? `${failedYears}件の年別リクエストで取得に失敗しました。時間を置いて再検索してください。`
            : undefined,
      });
    }

    return NextResponse.json({
      queryGroup: { label, terms },
      yearRange: { from, to },
      mode,
      generatedAt: new Date().toISOString(),
      sources,
      notes,
      sourcesInfo: officialSources,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : '検索処理で予期しないエラーが発生しました。',
      },
      { status: 500 },
    );
  }
}

function normalizeTerms(terms: string[]) {
  return Array.from(
    new Set(
      terms
        .flatMap((term) => term.split(/[,、\n]/))
        .map((term) => term.trim())
        .filter(Boolean),
    ),
  );
}

async function buildTermResults(
  source: SourceId,
  terms: string[],
  from: number,
  to: number,
): Promise<TermResult[]> {
  const results: TermResult[] = [];
  for (const term of terms) {
    const yearly = [];
    for (let year = from; year <= to; year += 1) {
      const count =
        source === 'bibliography'
          ? await fetchBibliographyCount(term, year)
          : await fetchProceedingsCount(term, year);
      yearly.push({ year, count });
      await sleep(source === 'bibliography' ? 1_000 : 150);
    }
    const total = yearly.reduce((sum, item) => sum + item.count, 0);
    results.push({
      term,
      firstYear: yearly.find((item) => item.count > 0)?.year ?? null,
      total,
      yearly,
      errors: 0,
    });
  }
  return results;
}

async function fetchBibliographyCount(term: string, year: number) {
  return cachedCount('bibliography', term, year, async () => {
    const query = `title="${escapeCql(term)}" AND from="${year}" AND until="${year}"`;
    const params = new URLSearchParams({
      operation: 'searchRetrieve',
      maximumRecords: '1',
      recordPacking: 'xml',
      mediatype: 'books',
      query,
    });
    const response = await fetchWithTimeout(
      `https://ndlsearch.ndl.go.jp/api/sru?${params}`,
      {
        headers: { Accept: 'application/xml,text/xml' },
        cache: 'force-cache',
        next: { revalidate: 7 * 24 * 60 * 60 },
      },
      35_000,
    );
    if (response.status === 429) {
      throw new Error('NDLサーチAPIが429を返しました。時間を置いて再検索してください。');
    }
    if (!response.ok) {
      throw new Error(`NDL Search API returned ${response.status}`);
    }
    return extractXmlNumber(await response.text(), 'numberOfRecords');
  });
}

async function fetchProceedingsCount(term: string, year: number) {
  return cachedCount('proceedings', term, year, async () => {
    const params = new URLSearchParams({
      any: term,
      from: `${year}-01-01`,
      until: `${year}-12-31`,
      maximumRecords: '1',
      recordPacking: 'json',
    });
    const response = await fetchWithTimeout(
      `https://kokkai.ndl.go.jp/api/speech?${params}`,
      {
        headers: { Accept: 'application/json' },
        cache: 'force-cache',
        next: { revalidate: 7 * 24 * 60 * 60 },
      },
      10_000,
    );
    if (response.status === 429) {
      throw new Error('国会会議録APIが429を返しました。時間を置いて再検索してください。');
    }
    if (!response.ok) {
      throw new Error(`Kokkai API returned ${response.status}`);
    }
    const data = (await response.json()) as { numberOfRecords?: number };
    return Number(data.numberOfRecords ?? 0);
  });
}

async function cachedCount(
  source: SourceId,
  term: string,
  year: number,
  fetcher: () => Promise<number>,
) {
  const key = `${source}:${term}:${year}`;
  const now = Date.now();
  const cached = countCache.get(key);
  if (cached && cached.expiresAt > now) return cached.count;

  const pending = pendingCountRequests.get(key);
  if (pending) return pending;

  const request = fetcher()
    .then((count) => {
      countCache.set(key, { count, expiresAt: now + COUNT_CACHE_TTL_MS });
      return count;
    })
    .finally(() => {
      pendingCountRequests.delete(key);
    });
  pendingCountRequests.set(key, request);
  return request;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { next?: { revalidate: number } },
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(
        `API応答が${Math.round(timeoutMs / 1000)}秒を超えたため中断しました。`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function extractXmlNumber(xml: string, tagName: string) {
  const match = xml.match(new RegExp(`<${tagName}>(\\d+)<\\/${tagName}>`));
  return match ? Number(match[1]) : 0;
}

function aggregateYearly(terms: TermResult[], from: number, to: number) {
  const rows = [];
  for (let year = from; year <= to; year += 1) {
    rows.push({
      year,
      count: terms.reduce(
        (sum, term) =>
          sum + (term.yearly.find((item) => item.year === year)?.count ?? 0),
        0,
      ),
    });
  }
  return rows;
}

function escapeCql(term: string) {
  return term.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
