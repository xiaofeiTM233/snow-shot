import { createRouter, RouterProvider, createHashHistory } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";
import "./styles.css";
import "github-markdown-css/github-markdown.css";
import { GlobalContext } from "./components/globalContext";

// Set up a Router instance
const router = createRouter({
	routeTree,
	history: createHashHistory(),
	defaultPreload: false, // 禁用自动预加载，减少初始内存占用
	defaultPreloadDelay: 100, // 如果需要预加载，延迟100ms
	scrollRestoration: true,
});

// Register things for typesafety
declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}
const App = () => {
	return (
		<GlobalContext>
			<RouterProvider router={router} />
		</GlobalContext>
	);
};

export default App;
