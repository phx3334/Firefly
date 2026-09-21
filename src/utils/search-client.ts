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

// 从文本中最早出现的任一关键字位置开始截取摘要（最多 radius * 2 字符）并高亮
function buildSnippetText(text: string, keyword: string, radius = 90): string {
	const q = keyword.trim();
	if (!q) return escapeHtml(text.slice(0, radius * 2));
	const lower = text.toLowerCase();
	const terms = q.split(/\s+/).filter(Boolean);
	let idx = -1;
	for (const t of terms) {
		const i = lower.indexOf(t.toLowerCase());
		if (i >= 0 && (idx < 0 || i < idx)) idx = i;
	}
	if (idx < 0) idx = 0;
	const end = Math.min(text.length, idx + radius * 2);
	let snippet = text.slice(idx, end);
	if (idx > 0) snippet = "…" + snippet;
	if (end < text.length) snippet = snippet + "…";
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

export interface BuiltSearchResult {
	url: string;
	snippetHtml: string;
}

// 构造单条搜索结果的链接与摘要，保证「面板里看到的摘要行 / 跳转的小标题 /
// 正文里高亮的那一块」是同一处命中，三者不再各自计算：
// 1. 正文块命中（文档顺序第一个包含任一关键字的块）：
//    链接 = 文章地址?kw=关键字&blk=块id#最近小标题（块在首个标题前时 hash 用块 id），
//    摘要取自该块文本，文章页只在该块内标记关键字；
// 2. 仅描述命中（正文无命中）：摘要取描述行，描述不渲染在正文中，链接不带定位参数；
// 3. 仅标题/标签命中：摘要取正文开头（无高亮），链接为文章地址。
export function buildSearchResult(
	post: SearchPost,
	keyword: string,
): BuiltSearchResult {
	const q = keyword.trim();
	const terms = q.split(/\s+/).filter(Boolean);
	if (terms.length) {
		for (const block of post.blocks ?? []) {
			const lower = block.text.toLowerCase();
			if (terms.some((t) => lower.includes(t.toLowerCase()))) {
				const params = new URLSearchParams({ kw: q, blk: block.id });
				const hash = encodeURIComponent(block.headingId ?? block.id);
				return {
					url: `${post.url}?${params.toString()}#${hash}`,
					snippetHtml: buildSnippetText(block.text, q),
				};
			}
		}
		const desc = post.description ?? "";
		if (terms.some((t) => desc.toLowerCase().includes(t.toLowerCase()))) {
			return { url: post.url, snippetHtml: buildSnippetText(desc, q) };
		}
	}
	return {
		url: post.url,
		snippetHtml: escapeHtml(
			(post.content || post.description || "").slice(0, 180),
		),
	};
}
