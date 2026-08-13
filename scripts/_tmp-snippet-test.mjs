function escapeHtml(s) {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function highlight(text, keyword) {
	const escaped = escapeHtml(text);
	const terms = keyword.trim().split(/\s+/).filter(Boolean);
	if (!terms.length) return escaped;
	const re = new RegExp("(" + terms.join("|") + ")", "gi");
	return escaped.replace(re, "<mark>$1</mark>");
}
function buildSnippet(content, keyword, radius = 90) {
	const q = keyword.trim();
	if (!q) return escapeHtml(content.slice(0, radius * 2));
	const lower = content.toLowerCase();
	const terms = q.split(/\s+/).filter(Boolean);
	let idx = -1;
	for (const t of terms) {
		const i = lower.indexOf(t.toLowerCase());
		if (i >= 0 && (idx < 0 || i < idx)) idx = i;
	}
	if (idx < 0) idx = 0;
	const end = Math.min(content.length, idx + radius * 2);
	let snippet = content.slice(idx, end);
	if (idx > 0) snippet = "…" + snippet;
	if (end < content.length) snippet = snippet + "…";
	return highlight(snippet, q);
}

const content =
	"这是文章开头，介绍计算机网络的基础知识。".repeat(20) +
	"IPv6 地址与 IPv4 的对比在这里出现。".repeat(5) +
	"这是文章结尾。";
console.log("--- 关键词: IPv6 ---");
console.log(buildSnippet(content, "IPv6"));
console.log("--- 关键词: 网络 地址 ---");
console.log(buildSnippet(content, "网络 地址"));
console.log("--- 关键词: 不存在的词xyz ---");
console.log(buildSnippet(content, "不存在的词xyz"));
