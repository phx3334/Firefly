// 前端硬编码动态数据（不依赖远程 json 文件）
export interface LocalDynamic {
	id: string;
	published: number;
	html: string;
	images: Array<{ alt: string; src: string; title?: string }>;
	searchText: string;
	pinned?: boolean;
}

export const localDynamics: LocalDynamic[] = [
	{
		id: "local-2026-07-24",
		// 2026-07-24 02:21 (UTC+8)
		published: Date.UTC(2026, 6, 23, 18, 21, 0),
		html: "终于搞完这个静态博客了，今晚逃离后室都没有玩到😔",
		images: [],
		searchText: "终于搞完这个静态博客了，今晚逃离后室都没有玩到",
		pinned: false,
	},
];
