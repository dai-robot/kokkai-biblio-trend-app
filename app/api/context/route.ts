import { NextResponse } from 'next/server';

type SourceId = 'bibliography' | 'proceedings';

type ContextRequest = {
  source?: SourceId;
  terms?: string[];
  year?: number;
  limit?: number;
  filters?: {
    excludeMetadata?: boolean;
    dedupeMeeting?: boolean;
    minSpeechLength?: number;
  };
};

export const maxDuration = 60;

type ContextItem = {
  id: string;
  source: SourceId;
  term: string;
  date?: string;
  year: number;
  title: string;
  subtitle: string;
  speaker?: string;
  snippet: string;
  url?: string;
};

type RelatedTerm = {
  term: string;
  count: number;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ContextRequest;
    const source = body.source;
    const terms = normalizeTerms(body.terms ?? []);
    const year = Number(body.year);
    const limit = clamp(Number(body.limit ?? 10), 1, 20);

    if (source !== 'bibliography' && source !== 'proceedings') {
      return NextResponse.json(
        { error: '文脈を見るデータ源を指定してください。' },
        { status: 400 },
      );
    }
    if (terms.length !== 1) {
      return NextResponse.json(
        { error: '文脈取得では検索語を1語だけ指定してください。' },
        { status: 400 },
      );
    }
    if (
      !Number.isInteger(year) ||
      year < 1948 ||
      year > new Date().getFullYear()
    ) {
      return NextResponse.json(
        { error: '文脈取得の年指定が不正です。' },
        { status: 400 },
      );
    }

    const items =
      source === 'proceedings'
        ? await fetchProceedingContext(terms, year, limit, body.filters)
        : await fetchBibliographyContext(terms, year, limit);

    return NextResponse.json({
      source,
      terms,
      year,
      limit,
      count: items.length,
      items,
      relatedTerms:
        source === 'proceedings'
          ? extractRelatedTerms(items, terms[0])
          : ([] satisfies RelatedTerm[]),
      note:
        source === 'proceedings'
          ? '年・語で候補を少量取得し、会議録情報除外、短文除外、同一会議の重複抑制を適用しています。関連語は表示した代表発言内の簡易集計です。'
          : '年・語で候補を少量取得し、タイトル・著者・出版者・出版年を文脈として表示しています。',
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : '文脈取得中に予期しないエラーが発生しました。',
      },
      { status: 500 },
    );
  }
}

async function fetchProceedingContext(
  terms: string[],
  year: number,
  limit: number,
  filters: ContextRequest['filters'] = {},
): Promise<ContextItem[]> {
  const candidates: (ContextItem & {
    meetingId?: string;
    speechLength: number;
  })[] = [];
  const perTermLimit = Math.max(10, Math.ceil(limit * 2.5));

  for (const term of terms) {
    const params = new URLSearchParams({
      any: term,
      from: `${year}-01-01`,
      until: `${year}-12-31`,
      maximumRecords: String(perTermLimit),
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
    if (!response.ok) {
      throw new Error(`国会会議録APIが ${response.status} を返しました。`);
    }
    const data = (await response.json()) as {
      speechRecord?: {
        speechID?: string;
        issueID?: string;
        date?: string;
        nameOfHouse?: string;
        nameOfMeeting?: string;
        speaker?: string;
        speech?: string;
        speechURL?: string;
      }[];
    };

    for (const record of data.speechRecord ?? []) {
      const speech = record.speech ?? '';
      const speaker = record.speaker ?? '';
      candidates.push({
        id: record.speechID ?? `${term}-${candidates.length}`,
        source: 'proceedings',
        term,
        year,
        date: record.date,
        title: `${record.nameOfHouse ?? '国会'} ${record.nameOfMeeting ?? '会議名不明'}`,
        subtitle: record.date
          ? `${record.date} / ${speaker || '発言者不明'}`
          : speaker,
        speaker,
        snippet: makeSnippet(speech, term),
        url: record.speechURL,
        meetingId: record.issueID,
        speechLength: speech.length,
      });
    }
    await sleep(120);
  }

  const seenIds = new Set<string>();
  const seenMeetings = new Map<string, number>();
  const filtered = candidates
    .filter((item) => {
      if (seenIds.has(item.id)) return false;
      seenIds.add(item.id);
      if (filters.excludeMetadata && item.speaker === '会議録情報')
        return false;
      if (item.speechLength < (filters.minSpeechLength ?? 60)) return false;
      if (filters.dedupeMeeting && item.meetingId) {
        const count = seenMeetings.get(item.meetingId) ?? 0;
        if (count >= 1) return false;
        seenMeetings.set(item.meetingId, count + 1);
      }
      return true;
    })
    .sort((a, b) => {
      const aDate = a.date ?? '';
      const bDate = b.date ?? '';
      return aDate.localeCompare(bDate);
    });

  return filtered.slice(0, limit).map((item) => ({
    id: item.id,
    source: item.source,
    term: item.term,
    date: item.date,
    year: item.year,
    title: item.title,
    subtitle: item.subtitle,
    speaker: item.speaker,
    snippet: item.snippet,
    url: item.url,
  }));
}

async function fetchBibliographyContext(
  terms: string[],
  year: number,
  limit: number,
): Promise<ContextItem[]> {
  const candidates: ContextItem[] = [];
  const perTermLimit = Math.max(10, Math.ceil(limit * 1.8));

  for (const term of terms) {
    const query = `title="${escapeCql(term)}" AND from="${year}" AND until="${year}"`;
    const params = new URLSearchParams({
      operation: 'searchRetrieve',
      maximumRecords: String(perTermLimit),
      recordPacking: 'xml',
      recordSchema: 'dcndl',
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
    if (!response.ok) {
      throw new Error(`NDLサーチAPIが ${response.status} を返しました。`);
    }
    const xml = await response.text();
    candidates.push(...parseBibliographyRecords(xml, term, year));
    await sleep(120);
  }

  const seen = new Set<string>();
  return candidates
    .filter((item) => {
      const key = `${normalizeKey(item.title)}-${item.subtitle}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function parseBibliographyRecords(
  xml: string,
  term: string,
  year: number,
): ContextItem[] {
  const records = xml.match(/<record>[\s\S]*?<\/record>/g) ?? [];
  return records.map((record, index) => {
    const data = decodeEntities(extract(record, 'recordData'));
    const title =
      stripTags(extract(data, 'dc:title') || extract(data, 'dcterms:title')) ||
      'タイトル不明';
    const creator =
      stripTags(
        extract(data, 'dc:creator') || extract(data, 'dcndl:creator'),
      ) || '著者不明';
    const publisher = stripTags(extract(data, 'dc:publisher')) || '出版者不明';
    const identifier = stripTags(
      extract(data, 'dcndl:BibResource') || extract(data, 'dc:identifier'),
    );
    return {
      id: `${term}-${year}-${index}-${normalizeKey(title).slice(0, 24)}`,
      source: 'bibliography',
      term,
      year,
      title,
      subtitle: `${creator} / ${publisher} / ${year}年`,
      snippet: makeSnippet(title, term),
      url: identifier.includes('ndlsearch.ndl.go.jp') ? identifier : undefined,
    };
  });
}

function makeSnippet(text: string, term: string) {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return '本文またはタイトルのプレビューを取得できませんでした。';
  const index = compact
    .toLocaleLowerCase('ja-JP')
    .indexOf(term.toLocaleLowerCase('ja-JP'));
  if (index < 0) return compact.slice(0, 180);
  const start = Math.max(0, index - 70);
  const end = Math.min(compact.length, index + term.length + 110);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < compact.length ? '...' : '';
  return `${prefix}${compact.slice(start, end)}${suffix}`;
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

function extract(value: string, tagName: string) {
  const escaped = tagName.replace(':', '\\:');
  const match = value.match(
    new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`),
  );
  return match?.[1]?.trim() ?? '';
}

function stripTags(value: string) {
  return decodeEntities(
    value
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

function decodeEntities(value: string) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
}

function escapeCql(term: string) {
  return term.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function normalizeKey(value: string) {
  return value.toLocaleLowerCase('ja-JP').replace(/\s+/g, '');
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractRelatedTerms(items: ContextItem[], searchTerm: string) {
  const stopwords = new Set([
    searchTerm.toLocaleLowerCase('ja-JP'),
    'これ',
    'それ',
    'ため',
    'こと',
    'もの',
    'よう',
    'これら',
    'について',
    'として',
    'そして',
    'また',
    'この',
    'その',
    'ます',
    'です',
    'する',
    'した',
    'ある',
    'いる',
    'ない',
    '政府',
    '委員',
    '大臣',
    '国会',
  ]);
  const counts = new Map<string, number>();
  const tokenPattern =
    /[A-Za-z][A-Za-z0-9+#.-]{1,}|[一-龠々〆ヵヶ]{2,}|[ァ-ヶー]{2,}|[ぁ-ん]{3,}/g;

  for (const item of items) {
    const tokens = item.snippet.match(tokenPattern) ?? [];
    for (const token of tokens) {
      const normalized = token.toLocaleLowerCase('ja-JP');
      if (stopwords.has(normalized)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term, 'ja-JP'))
    .slice(0, 10);
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
