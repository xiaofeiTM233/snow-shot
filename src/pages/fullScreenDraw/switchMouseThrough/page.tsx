"use client";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button, theme } from "antd";
import { useCallback, useContext, useEffect, useState } from "react";
import { FormattedMessage } from "react-intl";
import { EventListenerContext } from "@/components/eventListener";
import { MouseThroughIcon } from "@/components/icons";
import { fullScreenDrawChangeMouseThrough } from "@/functions/fullScreenDraw";
import { setWindowRect } from "@/utils/window";

const PAGE_WIDTH = 256;
const PAGE_HEIGHT = 32;

export const SwitchMouseThroughPage: React.FC = () => {
	const { token } = theme.useToken();

	const [enable, setEnable] = useState(false);

	const init = useCallback(async () => {
		const hash = window.location.hash;
		const search = hash.includes("?") ? hash.slice(hash.indexOf("?")) : window.location.search;
		const urlParams = new URLSearchParams(search);
		const monitor_x = parseInt(urlParams.get("monitor_x") ?? "0", 10);
		const monitor_y = parseInt(urlParams.get("monitor_y") ?? "0", 10);

		const appWindow = getCurrentWindow();
		const scaleFactor = window.devicePixelRatio;

		const physicalWidth = Math.round(PAGE_WIDTH * scaleFactor);
		const physicalHeight = Math.round(PAGE_HEIGHT * scaleFactor);

		const screenWidth = Math.round(window.screen.width * scaleFactor);

		const centerX = Math.round((screenWidth - physicalWidth) / 2);

		setWindowRect(appWindow, {
			min_x: monitor_x + centerX,
			min_y: monitor_y,
			max_x: monitor_x + centerX + physicalWidth,
			max_y: monitor_y + physicalHeight,
		});
	}, []);

	useEffect(() => {
		init();
	}, [init]);

	useEffect(() => {
		const appWindow = getCurrentWindow();
		if (enable) {
			appWindow.setIgnoreCursorEvents(false);
		} else {
			appWindow.setIgnoreCursorEvents(true);
		}
	}, [enable]);

	const { addListener, removeListener } = useContext(EventListenerContext);
	useEffect(() => {
		const listenerId = addListener(
			"full-screen-draw-change-mouse-through",
			() => {
				setEnable(!enable);
			},
		);

		const closeListenerId = addListener("close-full-screen-draw", () => {
			getCurrentWindow().close();
		});

		return () => {
			removeListener(listenerId);
			removeListener(closeListenerId);
		};
	}, [addListener, removeListener, enable]);

	return (
		<div className="container" onContextMenu={(e) => e.preventDefault()}>
			<Button
				block
				icon={<MouseThroughIcon />}
				onClick={() => {
					fullScreenDrawChangeMouseThrough();
				}}
			>
				<FormattedMessage id="fullScreenDraw.mouseThrough" />
			</Button>

			<style jsx>{`
                .container {
                    width: 100%;
                    height: 100%;
                    box-sizing: border-box;
                    flex-direction: column;
                    align-items: center;
                    cursor: pointer;
                    padding: 0 3px 3px 3px;
                    ${enable ? "opacity: 0.42;" : "opacity: 0 !important;"}
                    transition: opacity ${token.motionDurationMid} ${token.motionEaseInOut};
                }

                .container:hover {
                    opacity: 1;
                }

                .container :global(.ant-btn) {
                    border-top-left-radius: 0;
                    border-top-right-radius: 0;
                    border-top: unset;
                }
            `}</style>
		</div>
	);
};
