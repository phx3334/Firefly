<script lang="ts">
import I18nKey from "@i18n/i18nKey";
import { i18n } from "@i18n/translation";
import { onMount } from "svelte";
import Icon from "@/components/common/Icon.svelte";
import SearchResultItem from "@/components/pages/SearchResultItem.svelte";
import {
	loadSearchIndex,
	searchPosts,
	highlight,
	buildSearchResult,
	type SearchPost,
} from "@/utils/search-client";

export let keyword: string = "";

let results: { url: string; titleHtml: string; snippetHtml: string }[] = [];
let isSearching = false;
let initialized = false;
let index: SearchPost[] = [];

const search = (): void => {
	if (!keyword.trim()) {
		results = [];
		return;
	}
	isSearching = true;
	const posts = searchPosts(index, keyword);
	results = posts.map((p) => {
		const built = buildSearchResult(p, keyword);
		return {
			url: built.url,
			titleHtml: highlight(p.title, keyword),
			snippetHtml: built.snippetHtml,
		};
	});
	isSearching = false;
};

// 监听 URL 中的 q 参数变化（前进/后退）
const handlePopState = (): void => {
	const url = new URL(window.location.href);
	const q = url.searchParams.get("q") ?? "";
	if (q !== keyword) {
		keyword = q;
		search();
	}
};

onMount(() => {
	// static 部署时 SSR 无法获取 query（search.astro 在 build 时预渲染，
	// keyword prop 为空），因此统一从客户端 URL 读取关键词，再由下方
	// reactive 触发搜索；同时避免 onMount 返回 Promise 造成的类型错误。
	const params = new URLSearchParams(window.location.search);
	const q = params.get("q");
	loadSearchIndex().then((data) => {
		index = data;
		if (q) keyword = q; // 设置关键词，触发下方 reactive 首次搜索
		initialized = true;
	});
	window.addEventListener("popstate", handlePopState);
	return () => window.removeEventListener("popstate", handlePopState);
});

$: if (initialized && keyword !== undefined) {
	// 关键字变化时更新 URL 并搜索
	const url = new URL(window.location.href);
	if (keyword.trim()) {
		url.searchParams.set("q", keyword);
	} else {
		url.searchParams.delete("q");
	}
	window.history.replaceState({}, "", url);
	search();
}
</script>

<div class="flex flex-col gap-6 text-neutral-800 dark:text-neutral-200">
	<div class="relative">
		<input
			type="text"
			class="w-full rounded-lg bg-zinc-500/30 py-3 pl-11 pr-4 text-white placeholder:text-white/70 focus:outline-none focus:ring-2 focus:ring-(--primary)"
			placeholder={i18n(I18nKey.searchTypeSomething)}
			bind:value={keyword}
		/>
		<Icon
			class="absolute left-4 top-1/2 -translate-y-1/2 text-white/80"
			icon="material-symbols:search"
		/>
	</div>

	<div class="text-sm opacity-60">
		{#if isSearching}
			{i18n(I18nKey.searchLoading)}
		{:else if keyword.trim() && results.length > 0}
			{i18n(I18nKey.searchSummary)} {results.length}
		{:else if keyword.trim()}
			<span class="search-no-results">{i18n(I18nKey.searchNoResults)}</span>
		{/if}
	</div>

	<!-- 结果列表与导航栏搜索浮层共用 SearchResultItem：标题 + 摘要，无封面/元信息 -->
	<div class="flex flex-col gap-2">
		{#each results as result}
			<SearchResultItem
				url={result.url}
				titleHtml={result.titleHtml}
				snippetHtml={result.snippetHtml}
			/>
		{/each}
	</div>
</div>
