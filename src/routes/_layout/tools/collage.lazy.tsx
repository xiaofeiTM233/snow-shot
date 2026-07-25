import { createLazyFileRoute } from "@tanstack/react-router";
import { CollagePage } from "@/pages/tools/collage/page";

export const Route = createLazyFileRoute("/_layout/tools/collage")({
	component: CollageComponent,
});

function CollageComponent() {
	return <CollagePage />;
}
