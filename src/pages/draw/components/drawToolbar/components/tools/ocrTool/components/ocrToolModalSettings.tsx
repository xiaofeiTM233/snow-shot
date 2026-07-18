import { SettingOutlined } from "@ant-design/icons";
import { ModalForm } from "@ant-design/pro-components";
import { Button } from "antd";
import { FormattedMessage, useIntl } from "react-intl";
import { TranslationConfig } from "@/pages/settings/functionSettings/components/translationConfig";

export const OcrToolModalSettings: React.FC<{
	onFinish: () => Promise<void>;
}> = ({ onFinish }) => {
	const intl = useIntl();

	return (
		<ModalForm
			title={<FormattedMessage id="draw.ocrToolModalSettings.title" />}
			trigger={
				<Button
					icon={<SettingOutlined />}
					title={intl.formatMessage({ id: "draw.ocrToolModalSettings.title" })}
					key="ocrToolModalSettings"
					type="text"
				/>
			}
			onFinish={async () => {
				await onFinish();
				return true;
			}}
			modalProps={{
				centered: true,
				forceRender: false,
			}}
		>
			{/* <GroupTitle id="translationSettings">
				<FormattedMessage id="settings.functionSettings.translationSettings" />
			</GroupTitle> */}
			<TranslationConfig />
		</ModalForm>
	);
};
