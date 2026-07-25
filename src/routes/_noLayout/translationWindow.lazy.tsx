import { createLazyFileRoute, useSearch } from "@tanstack/react-router";
import { TranslationCore } from "@/pages/tools/translation/page";

export const Route = createLazyFileRoute("/_noLayout/translationWindow")({
	component: TranslationWindowComponent,
});

function TranslationWindowComponent() {
	const searchParams = useSearch({ from: "/_noLayout/translationWindow" }) as {
		t?: string;
		selectText?: string;
	};
	return (
		<TranslationCore
			searchParamsSign={searchParams.t}
			searchParamsSelectText={searchParams.selectText}
		/>
	);
}
