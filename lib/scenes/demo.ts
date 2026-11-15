// Local registry of supported scans. Add a model id and display name here to serve another scene.
export const DEMO_SCENES = {
  /** J&B Food Market, Houston: the scan Mann's walkthrough (jb_store/) was built on. The home page opens it. */
  UzwrJ9TbQuG: "J&B Food Market",
  /** Sample Storefront (Matterport's sample model). */
  Muo5jpq44Xk: "Sample Storefront",
} as const;

export type DemoModelId = keyof typeof DEMO_SCENES;
export const HOME_SCENE: DemoModelId = "UzwrJ9TbQuG";
export const isDemoScene = (modelId: string): modelId is DemoModelId => Object.hasOwn(DEMO_SCENES, modelId);
