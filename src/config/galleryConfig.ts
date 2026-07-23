import type { GalleryConfig } from "@/types/galleryConfig";

// 相册配置
export const galleryConfig: GalleryConfig = {
	// 相册列表
	albums: [
		{
			id: "b4",
			name: "睿智的八奈见同学",
			description: "领域展开！老八御厨子！",
			cover: "gallery/b4/b4.jpg",
			tags: [],
			featured: true,
		},
	],

	// 瀑布流最小列宽(px)，浏览器根据容器宽度自动计算列数，默认 240
	// 值越小列数越多，值越大列数越少
	columnWidth: 240,
};
