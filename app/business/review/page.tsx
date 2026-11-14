"use client";
// Observation queue + detail. Replaces the separate adaptive-inventory review screen described in the handoff
// (app/staff/inventory is not present in this repository).
import { ReviewDetail } from "@/components/business/ReviewDetail";
import { ReviewQueue } from "@/components/business/ReviewQueue";
import { useStaff, withSnap } from "@/components/business/StaffProvider";

function ReviewPage() {
  const { reviewId } = useStaff();
  return reviewId ? <ReviewDetail key={reviewId} id={reviewId} /> : <ReviewQueue />;
}

export default withSnap(ReviewPage);
