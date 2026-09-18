// Markdown 渲染管线的单一事实来源：
// astro.config 的正文渲染与 /api/search.json 的块索引解析共用同一套插件，
// 保证搜索索引里每个块的文本与正文渲染产物逐字一致，锚点 id 才不会错位。

import katex from "katex";
import "katex/dist/contrib/mhchem.mjs";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeCallouts from "rehype-callouts";
import rehypeComponents from "rehype-components";
import rehypeKatex from "rehype-katex";
import rehypeSlug from "rehype-slug";
import remarkAdmonitionToBlockquoteCallout from "remark-admonition-to-blockquote-callout";
import remarkDirective from "remark-directive";
import remarkMath from "remark-math";
import remarkSectionize from "remark-sectionize";
import { mermaidConfig, plantumlConfig, siteConfig } from "../config/index.ts";
import { GithubCardComponent } from "./rehype-component-github-card.mjs";
import rehypeBlockAnchors from "./rehype-block-anchors.mjs";
import { rehypeDiagramPanZoom } from "./rehype-diagram-panzoom.mjs";
import rehypeEmailProtection from "./rehype-email-protection.mjs";
import rehypeExternalLinks from "./rehype-external-links.mjs";
import rehypeFigure from "./rehype-figure.mjs";
import rehypeImageReferrerPolicy from "./rehype-image-referrerpolicy.mjs";
import { rehypeMermaid } from "./rehype-mermaid.mjs";
import { rehypePlantuml } from "./rehype-plantuml.mjs";
import { parseDirectiveNode } from "./remark-directive-rehype.js";
import { remarkExcerpt } from "./remark-excerpt.js";
import { remarkImageGrid } from "./remark-image-grid.js";
import { remarkMermaid } from "./remark-mermaid.js";
import { remarkPlantuml } from "./remark-plantuml.js";
import { remarkReadingTime } from "./remark-reading-time.mjs";

// 与 Astro 默认行为一致：gfm / smartypants 由调用方在 parse 后先挂，
// 用户 remark 插件随后，最后 remark-rehype。
export function getRemarkPlugins() {
	return [
		...(siteConfig.post.rehypeCallouts.enablePythonMarkdownAdmonitions !== false
			? [remarkAdmonitionToBlockquoteCallout]
			: []),
		remarkMath,
		remarkReadingTime,
		remarkImageGrid,
		remarkExcerpt,
		remarkDirective,
		remarkSectionize,
		parseDirectiveNode,
		remarkMermaid,
		[remarkPlantuml, plantumlConfig],
	];
}

// collectBlocks=true 时块锚点插件会把 [{id, text}] 写到 vfile.data.blocks
export function getRehypePlugins({ collectBlocks = false } = {}) {
	return [
		[rehypeKatex, { katex }],
		[rehypeCallouts, { theme: siteConfig.post.rehypeCallouts.theme }],
		rehypeSlug,
		[rehypeBlockAnchors, { collect: collectBlocks }],
		[rehypeMermaid, mermaidConfig],
		rehypePlantuml,
		rehypeDiagramPanZoom,
		rehypeFigure,
		[
			rehypeImageReferrerPolicy,
			{ domains: siteConfig.imageOptimization?.noReferrerDomains || [] },
		],
		[rehypeExternalLinks, { siteUrl: siteConfig.site_url }],
		[rehypeEmailProtection, { method: "base64" }],
		[
			rehypeComponents,
			{
				components: {
					github: GithubCardComponent,
				},
			},
		],
		[
			rehypeAutolinkHeadings,
			{
				behavior: "append",
				properties: {
					className: ["anchor"],
				},
				content: {
					type: "element",
					tagName: "span",
					properties: {
						className: ["anchor-icon"],
						"data-pagefind-ignore": true,
					},
					children: [
						{
							type: "text",
							value: "#",
						},
					],
				},
			},
		],
	];
}
