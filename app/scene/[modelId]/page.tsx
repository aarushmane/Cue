import { Suspense } from "react";
import { notFound } from "next/navigation";
import { DEMO_SCENES, isDemoScene } from "@/lib/scenes/demo";
import { SceneViewer } from "@/components/scene/SceneViewer";

export default function ScenePage({ params }: PageProps<"/scene/[modelId]">) {
  return (
    <Suspense fallback={<main className="scene" aria-busy="true" />}>
      <Scene params={params} />
    </Suspense>
  );
}

async function Scene({ params }: { params: PageProps<"/scene/[modelId]">["params"] }) {
  const { modelId } = await params;
  if (!isDemoScene(modelId)) notFound();
  return <SceneViewer modelId={modelId} name={DEMO_SCENES[modelId]} />;
}
