import { notFound } from "next/navigation";
import { BackgroundPaths } from "@/components/ui/background-paths";

/**
 * Component lab — isolated preview of the upstream `BackgroundPaths` hero,
 * unmodified, for evaluating the motion before wiring it into the real home
 * page.
 *
 * HARD-GATED TO LOCAL DEV: returns a 404 in a production build, so even if
 * this file is committed and deployed, defidesh.com/lab/background-paths does
 * not exist. Delete the whole `app/lab/` folder when the evaluation is done.
 */
export default function BackgroundPathsLabPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return <BackgroundPaths title="DefiDesh" />;
}
