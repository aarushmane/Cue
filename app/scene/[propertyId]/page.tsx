import { Suspense } from "react";
import { notFound } from "next/navigation";
import { findProperty } from "@/lib/db/properties";
import { SceneViewer } from "@/components/scene/SceneViewer";

// Cache Components: the property lookup is runtime data, so it streams inside <Suspense>. The
// fallback is the bare scene surface; the viewer shows its own loading state once it mounts.
export default function ScenePage({ params }: PageProps<"/scene/[propertyId]">) {
  return (
    <Suspense fallback={<main className="scene" aria-busy="true" />}>
      <Scene params={params} />
    </Suspense>
  );
}

async function Scene({ params }: { params: PageProps<"/scene/[propertyId]">["params"] }) {
  const { propertyId } = await params;
  if (!/^[0-9]{1,20}$/.test(propertyId)) notFound();
  const property = await findProperty(propertyId);
  if (!property || !/^[a-zA-Z0-9]{11}$/.test(property.matterport_model_id)) notFound();
  return <SceneViewer modelId={property.matterport_model_id} name={property.name} />;
}
