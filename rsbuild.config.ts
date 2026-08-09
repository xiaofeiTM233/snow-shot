import { defineConfig } from "@rsbuild/core";
import { pluginNodePolyfill } from "@rsbuild/plugin-node-polyfill";
import { pluginReact } from "@rsbuild/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/rspack";

export default defineConfig({
	plugins: [pluginReact(), pluginNodePolyfill()],
	resolve: {
		alias: {
			"@": "./src",
		},
	},
	output: {
		cleanDistPath: true,
	},
	performance: {
		chunkSplit: {
			strategy: "split-by-module",
		},
	},
	html: {
		tags: [
			{
				tag: "script",
				attrs: {
					src:
						import.meta.env.PUBLIC_ONLINE_STATUS === "true"
							? "/scripts/excalidraw.js"
							: "/scripts/excalidraw.offline.js",
				},
			},
			{
				tag: "script",
				attrs: {
					src: "/scripts/markdownItFix.js",
				},
			},
		],
	},
	tools: {
		swc: {
			jsc: {
				experimental: {
					plugins: [["@swc/plugin-styled-jsx", {}]],
				},
			},
		},
		rspack: {
			plugins: [
				tanstackRouter({
					target: "react",
					autoCodeSplitting: true,
				}),
			],
			optimization: {},
			module: {
				// rspack 内置把 .wasm 识别为 webassembly/async 模块，会尝试解析
				// wasm 的 import 段（wbg），并且没有 default 导出，导致
				// `import url from "xxx.wasm?url"` 构建失败。
				// 这里用 rule[].type = "asset/resource" 强制覆盖内置处理，
				// 让带 ?url 的 wasm 只作为静态资源 emit 并返回 URL。
				rules: [
					{
						test: /\.wasm$/,
						resourceQuery: /url/,
						type: "asset/resource",
						// 关闭内置 wasm parser 行为
						generator: {
							filename: "static/wasm/[name].[hash:8].wasm",
						},
					},
				],
			},
		},
	},
});
