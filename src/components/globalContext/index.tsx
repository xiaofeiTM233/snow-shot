import { App as AntdApp } from "antd";
import type React from "react";
import { useEffect } from "react";
import { HotkeysProvider } from "react-hotkeys-hook";

export const GlobalContext: React.FC<{
	children: React.ReactNode;
}> = ({ children }) => {
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (
				event.key === "F5" ||
				event.key === "F3" ||
				(event.ctrlKey && event.key === "r") ||
				(event.metaKey && event.key === "r") ||
				event.key === "Alt" || // 屏蔽 Alt + A, Alt + A 可能阻塞浏览器??? 逆天 Bug
				// 禁用浏览器前进后退快捷键
				(event.altKey && event.key === "ArrowLeft") || // Alt + 左箭头（后退）
				(event.altKey && event.key === "ArrowRight") // Alt + 右箭头（前进）
			) {
				event.preventDefault();
			}
		};

		// 禁用鼠标前进后退按钮
		const handleMouseDown = (event: MouseEvent) => {
			// button 3: 鼠标侧键后退, button 4: 鼠标侧键前进
			if (event.button === 3 || event.button === 4) {
				event.preventDefault();
				event.stopPropagation();
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		document.addEventListener("mousedown", handleMouseDown);
		document.addEventListener("mouseup", handleMouseDown); // 同时监听 mouseup 确保完全阻止

		return () => {
			document.removeEventListener("keydown", handleKeyDown);
			document.removeEventListener("mousedown", handleMouseDown);
			document.removeEventListener("mouseup", handleMouseDown);
		};
	}, []);

	return (
		<AntdApp>
			<HotkeysProvider>{children}</HotkeysProvider>
		</AntdApp>
	);
};
