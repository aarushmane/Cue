import { SceneViewer } from "@/components/scene/SceneViewer";
import { DEMO_SCENES, HOME_SCENE } from "@/lib/scenes/demo";

export default function Home() {
  return <SceneViewer modelId={HOME_SCENE} name={DEMO_SCENES[HOME_SCENE]} />;
}
