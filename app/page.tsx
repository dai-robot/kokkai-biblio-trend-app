'use client';

import {
  AlertCircle,
  BarChart3,
  BookOpen,
  CalendarDays,
  Database,
  ExternalLink,
  FileText,
  Filter,
  LineChart,
  ListFilter,
  Loader2,
  Search,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart as RechartsLineChart,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

type SearchMode = 'both' | 'bibliography' | 'proceedings';
type SourceId = 'bibliography' | 'proceedings';

type SourceResult = {
  source: SourceId;
  label: string;
  unit: string;
  firstYear: number | null;
  total: number;
  yearly: { year: number; count: number }[];
  terms: {
    term: string;
    firstYear: number | null;
    total: number;
    yearly: { year: number; count: number }[];
  }[];
  status: 'ok' | 'partial';
  error?: string;
};

type SearchResponse = {
  queryGroup: { label: string; terms: string[] };
  yearRange: { from: number; to: number };
  mode: SearchMode;
  generatedAt: string;
  sources: SourceResult[];
  notes: string[];
  sourcesInfo: { title: string; url: string }[];
};

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

type ContextResponse = {
  source: SourceId;
  terms: string[];
  year: number;
  limit: number;
  count: number;
  items: ContextItem[];
  relatedTerms?: { term: string; count: number }[];
  note: string;
};

type GrowthPoint = {
  source: SourceId;
  sourceLabel: string;
  year: number;
  count: number;
  previousCount: number;
  delta: number;
  growthRate: number;
  isSpike: boolean;
};

const currentYear = new Date().getFullYear();
const MAX_BIBLIOGRAPHY_YEARS = 5;
const MAX_PROCEEDINGS_YEARS = 90;

const sourceStyle: Record<
  SourceId,
  { color: string; icon: typeof BookOpen; short: string }
> = {
  bibliography: { color: '#216869', icon: BookOpen, short: '書誌' },
  proceedings: { color: '#b45f06', icon: FileText, short: '議事録' },
};

export default function Home() {
  const [mode, setMode] = useState<SearchMode>('both');
  const [searchTerm, setSearchTerm] = useState('人工知能');
  const [fromYear, setFromYear] = useState(currentYear - 1);
  const [toYear, setToYear] = useState(currentYear);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [contextSource, setContextSource] = useState<SourceId>('proceedings');
  const [contextTerm, setContextTerm] = useState('__group__');
  const [contextYear, setContextYear] = useState(currentYear);
  const [contextLimit, setContextLimit] = useState(5);
  const [excludeMetadata, setExcludeMetadata] = useState(true);
  const [dedupeMeeting, setDedupeMeeting] = useState(true);
  const [contextResult, setContextResult] = useState<ContextResponse | null>(
    null,
  );
  const [contextError, setContextError] = useState('');
  const [contextLoading, setContextLoading] = useState(false);
  const [minPreviousCount, setMinPreviousCount] = useState(5);

  const chartData = useMemo(() => {
    if (!result) return [];
    const years = Array.from(
      { length: result.yearRange.to - result.yearRange.from + 1 },
      (_, index) => result.yearRange.from + index,
    );

    return years.map((year) => {
      const row: Record<string, string | number> = { year };
      result.sources.forEach((source) => {
        row[source.source] =
          source.yearly.find((item) => item.year === year)?.count ?? 0;
      });
      return row;
    });
  }, [result]);

  const leader = useMemo(() => {
    if (!result || result.sources.length < 2) return null;
    const [a, b] = result.sources;
    if (a.firstYear === null && b.firstYear === null)
      return 'まだ出現がありません';
    if (a.firstYear === null) return `${b.label}が先に出現`;
    if (b.firstYear === null) return `${a.label}が先に出現`;
    if (a.firstYear === b.firstYear) return `${a.firstYear}年に同時出現`;
    return a.firstYear < b.firstYear
      ? `${a.label}が${b.firstYear - a.firstYear}年先行`
      : `${b.label}が${a.firstYear - b.firstYear}年先行`;
  }, [result]);

  const growthPoints = useMemo(() => {
    if (!result) return [];
    return result.sources.flatMap((source) =>
      buildGrowthPoints(source, minPreviousCount),
    );
  }, [result, minPreviousCount]);

  const spikeYears = useMemo(
    () =>
      growthPoints
        .filter((point) => point.isSpike)
        .sort(
          (a, b) =>
            b.growthRate - a.growthRate ||
            b.delta - a.delta ||
            a.year - b.year,
        ),
    [growthPoints],
  );

  async function runSearch(event: { preventDefault: () => void }) {
    event.preventDefault();
    setError('');

    const term = searchTerm.trim();
    if (!term) {
      setError('検索語を入力してください。');
      return;
    }
    if (term.includes(',') || term.includes('、') || /\s/.test(term)) {
      setError('検索語は1語だけ入力してください。');
      return;
    }
    if (fromYear > toYear) {
      setError('開始年は終了年以前にしてください。');
      return;
    }
    const span = toYear - fromYear + 1;
    const includesBibliography = mode === 'both' || mode === 'bibliography';
    if (includesBibliography && span > MAX_BIBLIOGRAPHY_YEARS) {
      setError(`NDL書誌を含む検索は${MAX_BIBLIOGRAPHY_YEARS}年以内にしてください。`);
      return;
    }
    if (!includesBibliography && span > MAX_PROCEEDINGS_YEARS) {
      setError(`国会議事録のみの検索は${MAX_PROCEEDINGS_YEARS}年以内にしてください。`);
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          queryGroup: {
            label: term,
            terms: [term],
          },
          yearRange: { from: fromYear, to: toYear },
        }),
      });
      const data = (await response.json()) as
        | SearchResponse
        | { error: string };
      if (!response.ok) {
        throw new Error('error' in data ? data.error : '検索に失敗しました。');
      }
      const nextResult = data as SearchResponse;
      setResult(nextResult);
      const defaultSource = nextResult.sources[0]?.source ?? 'proceedings';
      setContextSource(defaultSource);
      setContextTerm('__group__');
      setContextYear(
        getPeakYear(nextResult.sources[0], nextResult.yearRange.to),
      );
      setContextResult(null);
      setContextError('');
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : '検索中に予期しないエラーが発生しました。',
      );
    } finally {
      setLoading(false);
    }
  }

  async function runContextSearch() {
    if (!result) return;
    await runContextLookup({
      source: contextSource,
      terms: contextTerm === '__group__' ? result.queryGroup.terms : [contextTerm],
      year: contextYear,
      limit: contextLimit,
    });
  }

  async function runRepresentativeSpeeches(year: number) {
    if (!result) return;
    setContextSource('proceedings');
    setContextTerm('__group__');
    setContextYear(year);
    setContextLimit(5);
    await runContextLookup({
      source: 'proceedings',
      terms: result.queryGroup.terms,
      year,
      limit: 5,
    });
  }

  async function runContextLookup({
    source,
    terms,
    year,
    limit,
  }: {
    source: SourceId;
    terms: string[];
    year: number;
    limit: number;
  }) {
    const selectedTerms =
      terms.length > 0 ? terms : (result?.queryGroup.terms ?? []);

    setContextLoading(true);
    setContextError('');
    try {
      const response = await fetch('/api/context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source,
          terms: selectedTerms,
          year,
          limit,
          filters: {
            excludeMetadata,
            dedupeMeeting,
            minSpeechLength: 60,
          },
        }),
      });
      const data = (await response.json()) as
        | ContextResponse
        | { error: string };
      if (!response.ok) {
        throw new Error(
          'error' in data ? data.error : '文脈取得に失敗しました。',
        );
      }
      setContextResult(data as ContextResponse);
    } catch (caught) {
      setContextError(
        caught instanceof Error
          ? caught.message
          : '文脈取得中に予期しないエラーが発生しました。',
      );
    } finally {
      setContextLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <section className="border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="mx-auto grid max-w-7xl gap-7 px-5 py-6 md:grid-cols-[1fr_auto] md:items-end lg:px-8">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-white px-3 py-1 text-xs font-semibold text-[var(--muted-foreground)]">
              <Database className="h-3.5 w-3.5" />
              公開データ横断検索トライアル
            </div>
            <h1 className="text-2xl font-semibold tracking-normal md:text-3xl">
              国会議事録・NDL書誌トレンド検索
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--muted-foreground)]">
              ひとつの検索語を入力し、データ源ごとの初出年と年次件数を確認します。NDL書誌は応答時間に配慮して短期間、国会議事録のみは長期範囲を扱えます。
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 rounded-md border border-[var(--border)] bg-white p-2 text-center">
            <Metric label="対象" value="2 API" />
            <Metric label="書誌範囲" value="最大5年" />
            <Metric label="単位" value="件数" />
          </div>
        </div>
      </section>

      <div className="mx-auto grid max-w-7xl gap-5 px-5 py-5 lg:grid-cols-[390px_minmax(0,1fr)] lg:px-8">
        <form
          onSubmit={runSearch}
          className="h-fit rounded-lg border border-[var(--border)] bg-white p-4 shadow-sm"
        >
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Search className="h-4 w-4" />
              検索条件
            </h2>
            <button
              type="submit"
              disabled={loading}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-[var(--primary)] px-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <LineChart className="h-4 w-4" />
              )}
              集計
            </button>
          </div>

          <fieldset className="space-y-2">
            <legend className="mb-2 text-xs font-semibold text-[var(--muted-foreground)]">
              検索対象
            </legend>
            <SegmentedMode mode={mode} setMode={setMode} />
          </fieldset>

          <label className="mt-4 block">
            <span className="text-xs font-semibold text-[var(--muted-foreground)]">
              検索語
            </span>
            <input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              className="mt-2 h-10 w-full rounded-md border border-[var(--border)] px-3 text-sm outline-none focus:border-[var(--primary)]"
            />
          </label>

          <div className="mt-5 grid grid-cols-2 gap-3">
            <label>
              <span className="text-xs font-semibold text-[var(--muted-foreground)]">
                開始年
              </span>
              <input
                type="number"
                min={1948}
                max={toYear}
                value={fromYear}
                onChange={(event) => setFromYear(Number(event.target.value))}
                className="mt-2 h-10 w-full rounded-md border border-[var(--border)] px-3 text-sm outline-none focus:border-[var(--primary)]"
              />
            </label>
            <label>
              <span className="text-xs font-semibold text-[var(--muted-foreground)]">
                終了年
              </span>
              <input
                type="number"
                min={fromYear}
                max={currentYear}
                value={toYear}
                onChange={(event) => setToYear(Number(event.target.value))}
                className="mt-2 h-10 w-full rounded-md border border-[var(--border)] px-3 text-sm outline-none focus:border-[var(--primary)]"
              />
            </label>
          </div>

          <div className="mt-4 rounded-md bg-[var(--surface)] p-3 text-xs leading-5 text-[var(--muted-foreground)]">
            <p>検索語は1語のみです。</p>
            <p>NDLを含む検索は最大5年、国会議事録のみは最大90年です。</p>
            <p>取得できない場合はサンプル値に逃がさず、エラーを表示します。</p>
          </div>
          {error ? (
            <p className="mt-3 flex gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </p>
          ) : null}
        </form>

        <section className="min-w-0 space-y-5">
          <ResultsOverview result={result} leader={leader} loading={loading} />

          <div className="rounded-lg border border-[var(--border)] bg-white p-4 shadow-sm">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="flex items-center gap-2 text-base font-semibold">
                  <BarChart3 className="h-4 w-4" />
                  年次推移
                </h2>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  書誌はタイトル検索の書誌レコード件数、議事録は本文検索の発言ヒット件数です。
                </p>
              </div>
              {result ? (
                <span className="rounded-md bg-[var(--surface)] px-2.5 py-1 text-xs text-[var(--muted-foreground)]">
                  {result.yearRange.from}-{result.yearRange.to}
                </span>
              ) : null}
            </div>
            <div className="h-[360px] min-w-0 w-full">
              {result ? (
                <ResponsiveContainer width="100%" height="100%">
                  <RechartsLineChart
                    data={chartData}
                    margin={{ left: 0, right: 16, top: 12 }}
                  >
                    <CartesianGrid stroke="#e7e2d8" strokeDasharray="3 3" />
                    <XAxis dataKey="year" tick={{ fontSize: 12 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                    <Tooltip
                      formatter={(value, name) => [
                        `${String(value)}件`,
                        name === 'bibliography' ? 'NDL書誌' : '国会議事録',
                      ]}
                      labelFormatter={(label) => `${String(label)}年`}
                    />
                    {result.sources.map((source) => (
                      <Line
                        key={source.source}
                        type="monotone"
                        dataKey={source.source}
                        name={source.label}
                        stroke={sourceStyle[source.source].color}
                        strokeWidth={2.5}
                        dot={false}
                        activeDot={{ r: 5 }}
                      />
                    ))}
                    {growthPoints
                      .filter((point) => point.isSpike)
                      .map((point) => (
                        <ReferenceDot
                          key={`${point.source}-${point.year}`}
                          x={point.year}
                          y={point.count}
                          r={5}
                          fill={sourceStyle[point.source].color}
                          stroke="#ffffff"
                          strokeWidth={2}
                        />
                      ))}
                  </RechartsLineChart>
                </ResponsiveContainer>
              ) : (
                <EmptyChart />
              )}
            </div>
          </div>

          {result ? <TermBreakdown result={result} /> : null}
          {result ? (
            <GrowthExplorer
              growthPoints={growthPoints}
              spikeYears={spikeYears}
              minPreviousCount={minPreviousCount}
              setMinPreviousCount={setMinPreviousCount}
              hasProceedings={result.sources.some(
                (source) => source.source === 'proceedings',
              )}
              onSelectRepresentativeYear={runRepresentativeSpeeches}
            />
          ) : null}
          {result ? (
            <ContextExplorer
              result={result}
              source={contextSource}
              setSource={setContextSource}
              term={contextTerm}
              setTerm={setContextTerm}
              year={contextYear}
              setYear={setContextYear}
              limit={contextLimit}
              setLimit={setContextLimit}
              excludeMetadata={excludeMetadata}
              setExcludeMetadata={setExcludeMetadata}
              dedupeMeeting={dedupeMeeting}
              setDedupeMeeting={setDedupeMeeting}
              loading={contextLoading}
              error={contextError}
              contextResult={contextResult}
              onSearch={runContextSearch}
            />
          ) : null}
          {result ? <SourceNotes result={result} /> : null}
        </section>
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-20 px-2">
      <div className="text-[11px] font-semibold text-[var(--muted-foreground)]">
        {label}
      </div>
      <div className="mt-1 text-sm font-semibold">{value}</div>
    </div>
  );
}

function SegmentedMode({
  mode,
  setMode,
}: {
  mode: SearchMode;
  setMode: (mode: SearchMode) => void;
}) {
  const items: { value: SearchMode; label: string; icon: typeof Database }[] = [
    { value: 'both', label: '両方比較', icon: Database },
    { value: 'bibliography', label: 'NDL書誌のみ', icon: BookOpen },
    { value: 'proceedings', label: '議事録のみ', icon: FileText },
  ];

  return (
    <div className="grid grid-cols-3 gap-1 rounded-md bg-[var(--surface)] p-1">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.value}
            type="button"
            onClick={() => setMode(item.value)}
            className={`inline-flex h-10 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-semibold transition ${
              mode === item.value
                ? 'bg-white text-[var(--foreground)] shadow-sm'
                : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

function ResultsOverview({
  result,
  leader,
  loading,
}: {
  result: SearchResponse | null;
  leader: string | null;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="grid gap-3 md:grid-cols-3">
        {[0, 1, 2].map((item) => (
          <div
            key={item}
            className="h-28 animate-pulse rounded-lg border border-[var(--border)] bg-white p-4"
          >
            <div className="h-3 w-24 rounded bg-stone-200" />
            <div className="mt-4 h-7 w-20 rounded bg-stone-200" />
            <div className="mt-3 h-3 w-32 rounded bg-stone-200" />
          </div>
        ))}
      </div>
    );
  }

  if (!result) {
    return (
      <div className="rounded-lg border border-dashed border-[var(--border)] bg-white p-6">
        <h2 className="text-base font-semibold">
          検索すると結果が表示されます
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--muted-foreground)]">
          検索語1語を、選択したデータ源へ照会します。
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-3 md:grid-cols-3">
      {result.sources.map((source) => {
        const Icon = sourceStyle[source.source].icon;
        return (
          <div
            key={source.source}
            className="rounded-lg border border-[var(--border)] bg-white p-4 shadow-sm"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-sm font-semibold">
                <Icon
                  className="h-4 w-4"
                  style={{ color: sourceStyle[source.source].color }}
                />
                {source.label}
              </span>
              {source.status !== 'ok' ? (
                <span className="rounded-md bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-700">
                  一部失敗
                </span>
              ) : null}
            </div>
            <div className="mt-4 text-2xl font-semibold">
              {source.firstYear ?? 'なし'}
              {source.firstYear ? <span className="text-sm">年</span> : null}
            </div>
            <p className="mt-2 text-xs text-[var(--muted-foreground)]">
              合計 {source.total.toLocaleString('ja-JP')}件 / {source.unit}
            </p>
            {source.error ? (
              <p className="mt-2 text-xs leading-5 text-amber-700">
                {source.error}
              </p>
            ) : null}
          </div>
        );
      })}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--ink)] p-4 text-white shadow-sm">
        <div className="text-sm font-semibold">先行関係</div>
        <div className="mt-4 text-2xl font-semibold">
          {leader ?? '単独表示'}
        </div>
        <p className="mt-2 text-xs text-white/70">
          初出年は指定範囲内で件数が1以上の最初の年です。
        </p>
      </div>
    </div>
  );
}

function EmptyChart() {
  return (
    <div className="flex h-full items-center justify-center rounded-md bg-[var(--surface)] text-sm text-[var(--muted-foreground)]">
      条件を入力して集計すると、ここに年次推移が表示されます。
    </div>
  );
}

function TermBreakdown({ result }: { result: SearchResponse }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-white p-4 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold">集計内訳</h2>
        <span className="rounded-md bg-[var(--surface)] px-2.5 py-1 text-xs text-[var(--muted-foreground)]">
          {result.queryGroup.terms.length}語
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted-foreground)]">
              <th className="py-2 pr-3 font-semibold">語</th>
              <th className="py-2 pr-3 font-semibold">データ源</th>
              <th className="py-2 pr-3 font-semibold">初出年</th>
              <th className="py-2 pr-3 text-right font-semibold">合計</th>
              <th className="py-2 font-semibold">ピーク年</th>
            </tr>
          </thead>
          <tbody>
            {result.sources.flatMap((source) =>
              source.terms.map((term) => {
                const peak = term.yearly.reduce(
                  (best, item) => (item.count > best.count ? item : best),
                  { year: result.yearRange.from, count: 0 },
                );
                return (
                  <tr
                    key={`${source.source}-${term.term}`}
                    className="border-b border-[var(--border)]"
                  >
                    <td className="py-2 pr-3 font-medium">{term.term}</td>
                    <td className="py-2 pr-3">
                      <span className="inline-flex items-center rounded-md bg-[var(--surface)] px-2 py-1 text-xs">
                        {sourceStyle[source.source].short}
                      </span>
                    </td>
                    <td className="py-2 pr-3">{term.firstYear ?? 'なし'}</td>
                    <td className="py-2 pr-3 text-right">
                      {term.total.toLocaleString('ja-JP')}
                    </td>
                    <td className="py-2">
                      {peak.count > 0
                        ? `${peak.year}年 (${peak.count}件)`
                        : 'なし'}
                    </td>
                  </tr>
                );
              }),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GrowthExplorer({
  growthPoints,
  spikeYears,
  minPreviousCount,
  setMinPreviousCount,
  hasProceedings,
  onSelectRepresentativeYear,
}: {
  growthPoints: GrowthPoint[];
  spikeYears: GrowthPoint[];
  minPreviousCount: number;
  setMinPreviousCount: (value: number) => void;
  hasProceedings: boolean;
  onSelectRepresentativeYear: (year: number) => void;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-white p-4 shadow-sm">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">急増年</h2>
          <p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
            前年比は「今年の件数 / 前年の件数」で計算します。前年件数がしきい値未満の年はノイズとして急増判定から外します。
          </p>
        </div>
        <label className="min-w-36 text-xs font-semibold text-[var(--muted-foreground)]">
          最低件数しきい値
          <input
            type="number"
            min={1}
            max={999}
            value={minPreviousCount}
            onChange={(event) =>
              setMinPreviousCount(Math.max(1, Number(event.target.value) || 1))
            }
            className="mt-2 h-9 w-full rounded-md border border-[var(--border)] px-3 text-sm outline-none focus:border-[var(--primary)]"
          />
        </label>
      </div>

      {spikeYears.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {spikeYears.slice(0, 6).map((point) => (
            <button
              key={`${point.source}-${point.year}`}
              type="button"
              onClick={() => {
                if (hasProceedings) onSelectRepresentativeYear(point.year);
              }}
              className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-3 text-left transition hover:border-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-60"
              disabled={!hasProceedings}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold">
                  {point.year}年 / {point.sourceLabel}
                </span>
                <span className="rounded-md bg-white px-2 py-1 text-xs font-semibold text-[var(--accent-strong)]">
                  前年比 {point.growthRate.toFixed(1)}倍
                </span>
              </div>
              <p className="mt-2 text-xs leading-5 text-[var(--muted-foreground)]">
                前年 {point.previousCount.toLocaleString('ja-JP')}件 → 当年{' '}
                {point.count.toLocaleString('ja-JP')}件、前年差 +{point.delta.toLocaleString('ja-JP')}件
              </p>
              <p className="mt-2 text-xs font-semibold text-[var(--foreground)]">
                {hasProceedings
                  ? 'クリックで代表発言を表示'
                  : '代表発言は国会議事録を含む検索で表示できます'}
              </p>
            </button>
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-[var(--border)] p-4 text-sm text-[var(--muted-foreground)]">
          この条件では急増年は見つかりませんでした。年範囲を広げるか、最低件数しきい値を下げてください。
        </div>
      )}

      {growthPoints.length > 0 ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted-foreground)]">
                <th className="py-2 pr-3 font-semibold">年</th>
                <th className="py-2 pr-3 font-semibold">データ源</th>
                <th className="py-2 pr-3 text-right font-semibold">前年件数</th>
                <th className="py-2 pr-3 text-right font-semibold">当年件数</th>
                <th className="py-2 pr-3 text-right font-semibold">前年比</th>
                <th className="py-2 font-semibold">判定</th>
              </tr>
            </thead>
            <tbody>
              {growthPoints.map((point) => (
                <tr
                  key={`${point.source}-${point.year}-row`}
                  className="border-b border-[var(--border)]"
                >
                  <td className="py-2 pr-3 font-medium">{point.year}</td>
                  <td className="py-2 pr-3">{point.sourceLabel}</td>
                  <td className="py-2 pr-3 text-right">
                    {point.previousCount.toLocaleString('ja-JP')}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    {point.count.toLocaleString('ja-JP')}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    {point.growthRate.toFixed(2)}倍
                  </td>
                  <td className="py-2">
                    {point.isSpike ? (
                      <span className="rounded-md bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-700">
                        急増年
                      </span>
                    ) : (
                      <span className="text-xs text-[var(--muted-foreground)]">
                        通常
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function ContextExplorer({
  result,
  source,
  setSource,
  term,
  setTerm,
  year,
  setYear,
  limit,
  setLimit,
  excludeMetadata,
  setExcludeMetadata,
  dedupeMeeting,
  setDedupeMeeting,
  loading,
  error,
  contextResult,
  onSearch,
}: {
  result: SearchResponse;
  source: SourceId;
  setSource: (source: SourceId) => void;
  term: string;
  setTerm: (term: string) => void;
  year: number;
  setYear: (year: number) => void;
  limit: number;
  setLimit: (limit: number) => void;
  excludeMetadata: boolean;
  setExcludeMetadata: (value: boolean) => void;
  dedupeMeeting: boolean;
  setDedupeMeeting: (value: boolean) => void;
  loading: boolean;
  error: string;
  contextResult: ContextResponse | null;
  onSearch: () => void;
}) {
  const availableSources = result.sources.map((item) => item.source);
  const selectedSource =
    result.sources.find((item) => item.source === source) ?? result.sources[0];
  const years = Array.from(
    { length: result.yearRange.to - result.yearRange.from + 1 },
    (_, index) => result.yearRange.from + index,
  );

  return (
    <div className="rounded-lg border border-[var(--border)] bg-white p-4 shadow-sm">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <ListFilter className="h-4 w-4" />
            代表発言・文脈サンプル
          </h2>
          <p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
            急増年または任意の年を選び、代表発言や書誌例を3〜5件から確認します。
          </p>
        </div>
        <button
          type="button"
          onClick={onSearch}
          disabled={loading}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-[var(--ink)] px-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Filter className="h-4 w-4" />
          )}
          この条件で見る
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-[1fr_1fr_110px_110px]">
        <label>
          <span className="text-xs font-semibold text-[var(--muted-foreground)]">
            データ源
          </span>
          <select
            value={selectedSource.source}
            onChange={(event) => setSource(event.target.value as SourceId)}
            className="mt-2 h-10 w-full rounded-md border border-[var(--border)] bg-white px-3 text-sm outline-none focus:border-[var(--primary)]"
          >
            {availableSources.map((value) => (
              <option key={value} value={value}>
                {value === 'bibliography' ? 'NDL書誌' : '国会議事録'}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="text-xs font-semibold text-[var(--muted-foreground)]">
            検索語
          </span>
          <select
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            className="mt-2 h-10 w-full rounded-md border border-[var(--border)] bg-white px-3 text-sm outline-none focus:border-[var(--primary)]"
          >
            <option value="__group__">検索語</option>
            {result.queryGroup.terms.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="text-xs font-semibold text-[var(--muted-foreground)]">
            年
          </span>
          <select
            value={year}
            onChange={(event) => setYear(Number(event.target.value))}
            className="mt-2 h-10 w-full rounded-md border border-[var(--border)] bg-white px-3 text-sm outline-none focus:border-[var(--primary)]"
          >
            {years.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="text-xs font-semibold text-[var(--muted-foreground)]">
            件数
          </span>
          <select
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
            className="mt-2 h-10 w-full rounded-md border border-[var(--border)] bg-white px-3 text-sm outline-none focus:border-[var(--primary)]"
          >
            {[3, 5].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>

      {selectedSource.source === 'proceedings' ? (
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          <label className="flex items-center justify-between rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm">
            <span>会議録情報を除外</span>
            <input
              type="checkbox"
              checked={excludeMetadata}
              onChange={(event) => setExcludeMetadata(event.target.checked)}
              className="h-4 w-4 accent-[var(--primary)]"
            />
          </label>
          <label className="flex items-center justify-between rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm">
            <span>同一会議は1件まで</span>
            <input
              type="checkbox"
              checked={dedupeMeeting}
              onChange={(event) => setDedupeMeeting(event.target.checked)}
              className="h-4 w-4 accent-[var(--primary)]"
            />
          </label>
        </div>
      ) : null}

      <div className="mt-3 rounded-md bg-[var(--surface)] p-3 text-xs leading-5 text-[var(--muted-foreground)]">
        <p>
          負荷対策:
          年次グラフは集計API、文脈はこのパネルの条件で候補だけを最大20件取得します。
        </p>
        <p>
          将来SQL化する場合も、集計テーブルから先に絞り、本文・詳細JOINはこの段階だけに限定できます。
        </p>
      </div>

      {error ? (
        <p className="mt-3 flex gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </p>
      ) : null}

      {contextResult ? (
        <div className="mt-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold">
              {contextResult.year}年 /{' '}
              {contextResult.source === 'proceedings' ? '代表発言' : '書誌例'}{' '}
              {contextResult.count}件表示
            </p>
            <p className="text-xs text-[var(--muted-foreground)]">
              {contextResult.note}
            </p>
          </div>
          <div className="space-y-3">
            {contextResult.items.length > 0 ? (
              contextResult.items.map((item) => (
                <ContextCard key={item.id} item={item} />
              ))
            ) : (
              <div className="rounded-md border border-dashed border-[var(--border)] p-4 text-sm text-[var(--muted-foreground)]">
                この条件で表示できる文脈サンプルはありませんでした。語や年、除外条件を変えてください。
              </div>
            )}
          </div>
          {contextResult.relatedTerms &&
          contextResult.relatedTerms.length > 0 ? (
            <div className="mt-4 rounded-md bg-[var(--surface)] p-3">
              <p className="text-xs font-semibold text-[var(--muted-foreground)]">
                共起しやすい関連語
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {contextResult.relatedTerms.map((item) => (
                  <span
                    key={item.term}
                    className="rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-[var(--foreground)] ring-1 ring-[var(--border)]"
                  >
                    {item.term} ({item.count})
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ContextCard({ item }: { item: ContextItem }) {
  return (
    <article className="rounded-md border border-[var(--border)] p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-[var(--surface)] px-2 py-1 text-[11px] font-semibold text-[var(--muted-foreground)]">
              {item.source === 'bibliography' ? 'NDL書誌' : '国会議事録'}
            </span>
            <span className="rounded-md bg-white px-2 py-1 text-[11px] font-semibold text-[var(--accent-strong)] ring-1 ring-[var(--border)]">
              {item.term}
            </span>
          </div>
          <h3 className="text-sm font-semibold">{item.title}</h3>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--muted-foreground)]">
            <CalendarDays className="h-3.5 w-3.5" />
            {item.subtitle}
          </p>
        </div>
        {item.url ? (
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-1 rounded-md border border-[var(--border)] px-2.5 text-xs font-semibold text-[var(--foreground)]"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {item.source === 'proceedings' ? '本文リンク' : '原文'}
          </a>
        ) : null}
      </div>
      <p className="mt-3 text-sm leading-6 text-[var(--foreground)]">
        {item.snippet}
      </p>
    </article>
  );
}

function SourceNotes({ result }: { result: SearchResponse }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <AlertCircle className="h-4 w-4" />
        データと利用条件メモ
      </h2>
      <ul className="space-y-1 text-xs leading-5 text-[var(--muted-foreground)]">
        {result.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        {result.sourcesInfo.map((source) => (
          <a
            key={source.url}
            href={source.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-white px-2.5 py-1.5 text-xs font-semibold text-[var(--foreground)]"
          >
            {source.title}
          </a>
        ))}
      </div>
    </div>
  );
}

function getPeakYear(source: SourceResult | undefined, fallback: number) {
  if (!source) return fallback;
  const peak = source.yearly.reduce(
    (best, item) => (item.count > best.count ? item : best),
    { year: fallback, count: -1 },
  );
  return peak.count > 0 ? peak.year : (source.firstYear ?? fallback);
}

function buildGrowthPoints(source: SourceResult, minPreviousCount: number) {
  const points: GrowthPoint[] = [];
  for (let index = 1; index < source.yearly.length; index += 1) {
    const previous = source.yearly[index - 1];
    const current = source.yearly[index];
    const previousCount = previous?.count ?? 0;
    const count = current?.count ?? 0;
    if (!current || previousCount <= 0) continue;
    const growthRate = count / previousCount;
    const delta = count - previousCount;
    points.push({
      source: source.source,
      sourceLabel:
        source.source === 'bibliography' ? 'NDL書誌' : '国会議事録',
      year: current.year,
      count,
      previousCount,
      delta,
      growthRate,
      isSpike:
        previousCount >= minPreviousCount && delta > 0 && growthRate >= 1.5,
    });
  }
  return points;
}
