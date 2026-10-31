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
		published: Date.UTC(2026, 6, 23, 10, 21, 0),
		html: "终于搞完这个静态博客了，今晚逃离后室都没有玩到😔",
		images: [],
		searchText: "终于搞完这个静态博客了，今晚逃离后室都没有玩到",
		pinned: false,
	},
	{
		id: "local-2026-08-15",
		published: Date.UTC(2026, 7, 15, 9, 21, 0),
		html: "怪猎世界太好玩了",
		images:[{ alt: "", src: "/images/d1.avif" }],
		searchText: "怪猎世界太好玩了",
		pinned: false,
	},
	{
		id: "local-2026-10-30",
		published: Date.UTC(2026, 9, 29, 8, 21, 0),
		html: "哎😮‍💨真拿你没办法🪑那就坐好咯,格拉默帝国苍穹战线的铁骑↑🤖🤖🤖，以烈焰燃尽一切的熔火骑↑士↓😡😡😡，行事决~绝~😨😨😨，不留余地的战争利器！😱😱😱这便是星核猎手 👿萨姆😡！留给敌人的恐怖印象，但不为人知的是😲😲😲！萨姆仅是装甲的代号😜😜😜！它的持有者其实是一位看似纤弱文静的少女↓😣😣😣，身着为战而生的装甲，为生而战！😡😡😡你敢和她对视十秒吗😜😜😜",
		images: [{ alt: "", src: "/images/d2.jpg" }],
		searchText: "格拉默帝国苍穹战线的铁骑",
		pinned: false,
	},
];
