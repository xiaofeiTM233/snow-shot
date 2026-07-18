"use client";

import {
	ModalForm,
	ProFormList,
	ProFormSwitch,
	ProFormText,
	ProFormTextArea,
} from "@ant-design/pro-components";
import { Alert, Col, Flex, Form, Row, Typography, theme } from "antd";
import type React from "react";
import { useImperativeHandle, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { IconLabel } from "@/components/iconLable";
import {
	type ChatWorkflowConfig,
	ChatWorkflowConfigStore,
} from "@/utils/appStore";

const initialValues = {
	flow_list: [
		{
			variable_name: "",
			ignore_context: true,
			message: "",
		},
	],
};

export type UpdateOrCreateWorkflowActionType = {
	setOpen: (value: boolean) => void;
};

export const USER_INPUT_ENV_VARIABLE = "{{USER_INPUT}}";

export const UpdateOrCreateWorkflow: React.FC<{
	workflow?: ChatWorkflowConfig;
	trigger?: React.ReactNode;
	actionRef?: React.RefObject<UpdateOrCreateWorkflowActionType | undefined>;
	onUpdateAction: () => void;
}> = ({ workflow, trigger, actionRef, onUpdateAction }) => {
	const intl = useIntl();
	const { token } = theme.useToken();

	const [open, setOpen] = useState(false);
	const [form] = Form.useForm<
		Omit<ChatWorkflowConfig, "id"> & { id: string | undefined }
	>();

	useImperativeHandle(
		actionRef,
		() => ({
			setOpen,
		}),
		[],
	);

	return (
		<div>
			<ModalForm<Omit<ChatWorkflowConfig, "id"> & { id: string | undefined }>
				form={form}
				open={open}
				trigger={trigger}
				onOpenChange={(value) => {
					if (value) {
						form.setFieldsValue(workflow ?? initialValues);
					}
					setOpen(value);
				}}
				title={<FormattedMessage id="tools.chat.createWorkflow" />}
				onFinish={async (values) => {
					const chatWorkflowConfigStore = new ChatWorkflowConfigStore();
					await chatWorkflowConfigStore.init();
					let configId: string;
					if (workflow) {
						configId = workflow.id;
					} else {
						configId = `${Date.now()}`;
					}
					await chatWorkflowConfigStore.set(configId, {
						...values,
						id: configId,
					});

					onUpdateAction();
					return true;
				}}
			>
				<Row gutter={token.marginLG}>
					<Col span={12}>
						<ProFormText
							name={"name"}
							label={intl.formatMessage({ id: "tools.chat.workflowName" })}
							rules={[{ required: true }]}
						/>
					</Col>
				</Row>
				<Row gutter={token.marginLG}>
					<Col span={24}>
						<ProFormTextArea
							name={"description"}
							label={intl.formatMessage({
								id: "tools.chat.workflowDescription",
							})}
							fieldProps={{
								autoSize: { minRows: 1 },
							}}
						/>
					</Col>
				</Row>

				<Alert
					message={
						<Typography>
							<div>
								<FormattedMessage id="tools.chat.workflowStep.environmentVariable" />
							</div>
							<div>
								<FormattedMessage id="tools.chat.workflowStep.environmentVariable.userInput" />
								<code>{USER_INPUT_ENV_VARIABLE}</code>
							</div>
						</Typography>
					}
					type="info"
					style={{ marginBottom: token.margin }}
				/>

				<ProFormList
					name="flow_list"
					label={intl.formatMessage({ id: "tools.chat.workflowStep" })}
					creatorButtonProps={{
						creatorButtonText: intl.formatMessage({
							id: "tools.chat.addWorkflowStep",
						}),
					}}
					min={1}
					className="chat-workflow-list"
					itemRender={({ listDom, action }) => (
						<Flex align="end" justify="space-between">
							{listDom}
							<div>{action}</div>
						</Flex>
					)}
					rules={[
						{
							required: true,
							validator: (_, value) => {
								if (!Array.isArray(value) || value.length === 0) {
									return Promise.reject(
										intl.formatMessage({
											id: "tools.chat.workflowStep.required",
										}),
									);
								}
								return Promise.resolve();
							},
						},
					]}
				>
					<Row gutter={token.marginLG} style={{ width: "100%" }}>
						<Col span={12}>
							<ProFormText
								name="variable_name"
								label={
									<IconLabel
										label={
											<FormattedMessage id="tools.chat.workflowStep.variableName" />
										}
										tooltipTitle={
											<FormattedMessage id="tools.chat.workflowStep.variableName.tip" />
										}
									/>
								}
							/>
						</Col>
						<Col span={12}>
							<ProFormSwitch
								name="ignore_context"
								label={
									<IconLabel
										label={
											<FormattedMessage id="tools.chat.workflowStep.ignoreContext" />
										}
										tooltipTitle={
											<FormattedMessage id="tools.chat.workflowStep.ignoreContext.tip" />
										}
									/>
								}
							/>
						</Col>
						<Col span={24}>
							<ProFormTextArea
								name="message"
								label={intl.formatMessage({
									id: "tools.chat.workflowStep.message",
								})}
								rules={[{ required: true }]}
								fieldProps={{
									autoSize: { minRows: 4 },
								}}
							/>
						</Col>
					</Row>
				</ProFormList>
			</ModalForm>

			<style jsx>{`
                :global(.chat-workflow-list .ant-pro-form-list-container) {
                    width: 100%;
                }
            `}</style>
		</div>
	);
};
