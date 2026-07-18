import type { ConversationItemType } from "@ant-design/x";
import type { MessageInfo } from "@ant-design/x-sdk";
import type {
	NonDeletedExcalidrawElement,
	Ordered,
} from "@mg-chao/excalidraw/element/types";
import type { AppState } from "@mg-chao/excalidraw/types";
import { load, type Store } from "@tauri-apps/plugin-store";
import { getAppConfigBaseDir } from "@/commands/file";
import type { ElementRect } from "@/types/commands/screenshot";

class BaseStore<Value> {
	protected instance: Store | undefined;
	protected name: string;
	protected autoSave: number;

	constructor(name: string, autoSave: number = 1000) {
		this.name = name;
		this.autoSave = autoSave;
	}

	public async init() {
		this.instance = await load(
			`${await getAppConfigBaseDir()}/stores/${this.name}.json`,
			{
				autoSave: this.autoSave,
				defaults: {},
			},
		);
	}

	public inited() {
		return !!this.instance;
	}

	public async set(key: string, value: Value) {
		if (!this.instance) {
			throw new Error("Store not initialized");
		}

		return await this.instance.set(key, value);
	}

	public async get(key: string): Promise<Value | undefined> {
		if (!this.instance) {
			throw new Error("Store not initialized");
		}

		return await this.instance.get<Value>(key);
	}

	public async entries(): Promise<[key: string, value: Value][]> {
		if (!this.instance) {
			throw new Error("Store not initialized");
		}

		return await this.instance.entries<Value>();
	}

	public async clear() {
		if (!this.instance) {
			throw new Error("Store not initialized");
		}

		return await this.instance.clear();
	}

	public async delete(key: string) {
		if (!this.instance) {
			throw new Error("Store not initialized");
		}

		return await this.instance.delete(key);
	}

	public async save() {
		if (!this.instance) {
			throw new Error("Store not initialized");
		}

		return await this.instance.save();
	}
}

export class ChatHistoryStore extends BaseStore<{
	session: ConversationItemType;
	messages: MessageInfo[];
}> {
	constructor() {
		super("chat-history", 1000);
	}
}

export class ExcalidrawAppStateStore extends BaseStore<{
	appState: Partial<AppState>;
}> {
	constructor() {
		super("excalidraw-app-state", 1000);
	}
}

export type ChatWorkflowFlow = {
	variable_name?: string;
	ignore_context: boolean;
	message: string;
};

export type ChatWorkflowConfig = {
	id: string;
	name: string;
	description?: string;
	flow_list: ChatWorkflowFlow[];
};

export class ChatWorkflowConfigStore extends BaseStore<ChatWorkflowConfig> {
	constructor() {
		super("chat-workflow-config", 0);
	}
}

export enum CaptureHistorySource {
	ScrollScreenshotCopy = "scroll-screenshot-copy",
	ScrollScreenshotSave = "scroll-screenshot-save",
	ScrollScreenshotFixed = "scroll-screenshot-fixed",
	Copy = "copy",
	Save = "save",
	Fixed = "fixed",
	FullScreen = "full-screen",
}

export type CaptureHistoryItem = {
	id: string;
	selected_rect: ElementRect;
	file_name: string;
	capture_result_file_name?: string;
	excalidraw_elements:
		| readonly Ordered<NonDeletedExcalidrawElement>[]
		| undefined;
	excalidraw_app_state: Pick<AppState, keyof AppState> | undefined;
	source?: CaptureHistorySource;
	create_ts: number;
};

export class CaptureHistoryStore extends BaseStore<CaptureHistoryItem> {
	constructor() {
		super("capture-history", 0);
	}
}

export const clearAllAppStore = async () => {
	// 忽略截图历史的存储，因为和图片文件关联
	// const chatHistoryStore = new ChatHistoryStore();
	const excalidrawAppStateStore = new ExcalidrawAppStateStore();
	const chatWorkflowConfigStore = new ChatWorkflowConfigStore();

	await Promise.all([
		// chatHistoryStore.init(),
		excalidrawAppStateStore.init(),
		chatWorkflowConfigStore.init(),
	]);

	await Promise.all([
		// chatHistoryStore.clear(),
		excalidrawAppStateStore.clear(),
		chatWorkflowConfigStore.clear(),
	]);
};
