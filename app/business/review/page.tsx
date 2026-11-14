"use client";
// Observation queue + detail. Camera-scan inventory suggestions (adaptive inventory) have their own queue at
// /business/sightings.
import { ReviewDetail } from "@/components/business/ReviewDetail";
import { ReviewQueue } from "@/components/business/ReviewQueue";
import { useStaff, withSnap } from "@/components/business/StaffProvider";

function ReviewPage() {
  const { reviewId } = useStaff();
  return reviewId ? <ReviewDetail key={reviewId} id={reviewId} /> : <ReviewQueue />;
}

export default withSnap(ReviewPage);
