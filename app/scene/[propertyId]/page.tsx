import { notFound } from "next/navigation";
import { findProperty } from "@/lib/db/properties";
import { SceneViewer } from "@/components/scene/SceneViewer";

export default async function ScenePage({ params }: { params: Promise<{ propertyId: string }> }) {
  const { propertyId } = await params;
  if (!/^[0-9]{1,20}$/.test(propertyId)) notFound();
  const property = await findProperty(propertyId);
  if (!property || !/^[a-zA-Z0-9]{11}$/.test(property.matterport_model_id)) notFound();
  return <SceneViewer modelId={property.matterport_model_id} name={property.name} />;
}
