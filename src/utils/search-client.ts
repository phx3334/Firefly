// 客户端文章搜索工具：加载由 /api/search.json 生成的静态索引并在浏览器内过滤。
// 无需后端服务，dev 与 build 均可工作。

export interface SearchBlock {
	id: string;
	text: string;
	headingId: string | null;
}

export interface SearchPost {
	url: string;
	title: string;
	description: string;
	tags: string[];
	date: string;
	excerpt: string;
	content: string;
	blocks?: SearchBlock[];
}

let cache: SearchPost[] | null = null;

export async function loadSearchIndex(): Promise<SearchPost[]> {
	if (cache) return cache;
	try {
		const base = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
		const res = await fetch(`${base}/api/search.json`);
		if (!res.ok) throw new Error(`search index ${res.status}`);
		const data = await res.json();
		if (Array.isArray(data)) cache = data as SearchPost[];
	} catch (err) {
		console.error("Failed to load search index:", err);
	}
	// 失败时 cache 仍为 null，下次调用会重试，避免一次失败导致后续永久返回空数组
	return cache ?? [];
}

export function searchPosts(index: SearchPost[], keyword: string): SearchPost[] {
	const q = keyword.trim().toLowerCase();
	if (!q) return [];
	const terms = q.split(/\s+/).filter(Boolean);
	return index.filter((post) => {
		const haystack = (
			post.title +
			" " +
			post.description +
			" " +
			post.tags.join(" ") +
			" " +
			post.content
		).toLowerCase();
		return terms.every((t) => haystack.includes(t));
	});
}

export function highlight(text: string, keyword: string): string {
	const escaped = escapeHtml(text);
	const terms = keyword
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map(escapeRegExp);
	if (!terms.length) return escaped;
	const re = new RegExp("(" + terms.join("|") + ")", "gi");
	return escaped.replace(re, "<mark>$1</mark>");
}

export function buildSnippet(
	content: string,
	keyword: string,
	radius = 90,
): string {
	const q = keyword.trim();
	if (!q) return escapeHtml(content.slice(0, radius * 2));
	const lower = content.toLowerCase();
	const terms = q.split(/\s+/).filter(Boolean);
	// 在所有命中词中取最靠前的位置作为锚点，保证摘要一定包含并标出关键字
	let idx = -1;
	for (const t of terms) {
		const i = lower.indexOf(t.toLowerCase());
		if (i >= 0 && (idx < 0 || i < idx)) idx = i;
	}
	if (idx < 0) idx = 0;
	// 摘要直接从第一个命中位置开始（最多 radius * 2 字符）
	const end = Math.min(content.length, idx + radius * 2);
	let snippet = content.slice(idx, end);
	if (idx > 0) snippet = "…" + snippet;
	if (end < content.length) snippet = snippet + "…";
	return highlight(snippet, q);
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 找到第一个包含任一关键字的块，返回它上方最近小标题的 id
// （关键字在标题上时返回该标题；文章开头无标题时返回 null）。
export function findNearestHeadingId(
	blocks: SearchBlock[],
	keyword: string,
): string | null {
	const terms = keyword
		.trim()
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean);
	if (!terms.length) return null;
	for (const block of blocks) {
		const lower = block.text.toLowerCase();
		if (terms.some((t) => lower.includes(t))) {
			return block.headingId;
		}
	}
	return null;
}

// 构造结果链接：?kw=关键字（文章页据此高亮）#最近小标题（原生锚点滚动）。
// 无小标题时只带 kw，落到文章顶部。
export function buildPostUrl(post: SearchPost, keyword: string): string {
	const firstTerm = keyword.trim().split(/\s+/)[0] ?? "";
	const headingId = findNearestHeadingId(post.blocks ?? [], keyword);
	let target = post.url;
	if (firstTerm) target += `?kw=${encodeURIComponent(firstTerm)}`;
	if (headingId) target += `#${headingId}`;
	return target;
}
