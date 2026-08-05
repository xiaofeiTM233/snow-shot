import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { appError, appWarn } from "@/utils/log";

// 将 console.error / console.warn 同时转发到 Tauri 日志，便于在日志文件中查看
const originalConsoleError = console.error.bind(console);
const originalConsoleWarn = console.warn.bind(console);
console.error = (...args: unknown[]) => {
	originalConsoleError(...args);
	try {
		appError(
			args
				.map((a) => (a instanceof Error ? a.stack || a.message : String(a)))
				.join(" "),
		);
	} catch {
		/* 忽略日志写入失败，不影响正常 console 输出 */
	}
};
console.warn = (...args: unknown[]) => {
	originalConsoleWarn(...args);
	try {
		appWarn(
			args
				.map((a) => (a instanceof Error ? a.stack || a.message : String(a)))
				.join(" "),
		);
	} catch {
		/* 忽略日志写入失败，不影响正常 console 输出 */
	}
};


const rootEl = document.getElementById("root");

if (rootEl) {
	const root = ReactDOM.createRoot(rootEl);
	root.render(
		<React.StrictMode>
			<App />
		</React.StrictMode>,
	);
}
