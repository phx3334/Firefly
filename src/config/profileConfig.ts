import type { ProfileConfig } from "../types/profileConfig";

export const profileConfig: ProfileConfig = {
	// 头像
	// 图片路径支持三种格式：
	// 1. public 目录（以 "/" 开头，不优化）："/assets/images/avatar.webp"
	// 2. src 目录（不以 "/" 开头，自动优化但会增加构建时间，推荐）："assets/images/avatar.webp"
	// 3. 远程 URL："https://example.com/avatar.jpg"
	avatar: "assets/images/avatar.jpg",

	// 名字
	name: "Hoein Chrome",

	// 个人签名
	bio: "Hello, I'm Hoein Chrome",

	// 链接配置
	// 已经预装的图标集：fa7-brands，fa7-regular，fa7-solid，material-symbols，simple-icons
	// 访问https://icones.js.org/ 获取图标代码，
	// 如果想使用尚未包含相应的图标集，则需要安装它
	// `pnpm add @iconify-json/<icon-set-name>`
	// showName: true 时显示图标和名称，false 时只显示图标
	links: [
		{
		name: "discord",
		icon: "fa7-brands:discord",
			url: "https://discord.gg/GjWuuNtuN",
			showName: false,
		},
		{
			name: "GitHub",
			icon: "fa7-brands:github",
			url: "https://github.com/phx3334",
			showName: false,
		},
		{
		name: "bilibili",
		icon: "simple-icons:bilibili",
			url: "http://192.238.143.219/",
			showName: false,
		},
		{
		name: "gitee",
		icon: "fa7-brands:gitee",
			url: "https://gitee.com/fzsirr",
			showName: false,
		},
	],
};
