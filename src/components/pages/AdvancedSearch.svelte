<script lang="ts">
import I18nKey from "@i18n/i18nKey";
import { i18n } from "@i18n/translation";
import { navigateToPage } from "@utils/navigation-utils";
import { onMount } from "svelte";
import Icon from "@/components/common/Icon.svelte";
import {
	loadSearchIndex,
	searchPosts,
	highlight,
	buildSnippet,
	type SearchPost,
} from "@/utils/search-client";

export let keyword: string = "";

let results: { url: string; titleHtml: string; excerptHtml: string }[] = [];
let isSearching = false;
let initialized = false;
let index: SearchPost[] = [];

const search = async (): Promise<void> => {
	if (!keyword.trim()) {
		results = [];
		return;
	}
	isSearching = true;
	const posts = searchPosts(index, keyword);
	results = posts.map((p) => ({
		url: p.url,
		titleHtml: highlight(p.title, keyword),
		excerptHtml: buildSnippet(p.content, keyword),
	}));
	isSearching = false;
};

const handleResultClick = (event: Event, target: string): void => {
	event.preventDefault();
	navigateToPage(target);
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

onMount(async () => {
	index = await loadSearchIndex();
	initialized = true;
	await search();
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

<div class="flex flex-col gap-6">
	<div class="relative">
		<input
			type="text"
			class="w-full rounded-full border border-(--card-border) bg-(--card-bg) py-3 pl-11 pr-4 text-(--text) focus:outline-none focus:ring-2 focus:ring-(--primary)"
			placeholder={i18n(I18nKey.searchTypeSomething)}
			bind:value={keyword}
		/>
		<Icon
			class="absolute left-4 top-1/2 -translate-y-1/2 text-(--text-muted)"
			icon="fa-solid fa-search"
			size="1rem"
		/>
	</div>

	<div class="text-sm text-(--text-muted)">
		{#if isSearching}
			{i18n(I18nKey.searchLoading)}
		{:else if keyword.trim() && results.length > 0}
			{i18n(I18nKey.searchSummary)} {results.length}
		{:else if keyword.trim()}
			{i18n(I18nKey.searchNoResults)}
		{/if}
	</div>

	<div class="flex flex-col gap-3">
		{#each results as result}
			<a
				href={result.url}
				on:click={(e) => handleResultClick(e, result.url)}
				class="flex flex-col gap-2 rounded-xl border border-(--card-border) bg-(--card-bg) p-4 transition-colors hover:border-(--primary)"
			>
				<div class="flex items-center gap-2 text-lg font-bold text-(--text)">
					{@html result.titleHtml}
					<Icon
						class="text-(--text-muted)"
						icon="fa-solid fa-arrow-right"
						size="0.9rem"
					/>
				</div>
				{#if result.excerptHtml.includes("<mark>")}
					<div class="line-clamp-3 text-sm text-(--text-muted)">
						{@html result.excerptHtml}
					</div>
				{/if}
			</a>
		{/each}
	</div>
</div>
