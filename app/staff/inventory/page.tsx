import { redirect } from "next/navigation";

// The shopper-sightings review now lives in the manager app, in the shared design.
export default function Page() {
  redirect("/business/sightings");
}
