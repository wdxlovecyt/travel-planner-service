import { z } from "zod";

const routePlanningModeSchema = z.enum(["walking", "driving", "transit", "riding"]);

const routePlanningSegmentInputSchema = z.object({
  segment_id: z.string().optional(),
  order: z.number().optional(),
  from_place_id: z.string().optional(),
  to_place_id: z.string().optional(),
  from_place_name: z.string().optional(),
  to_place_name: z.string().optional(),
  from_location: z.string().optional(),
  to_location: z.string().optional(),
  city: z.string().optional(),
  mode: routePlanningModeSchema.optional(),
});

export const planRequestSchema = z.object({
  message: z.string().trim().min(1, "message is required"),
});

export const routePlanRequestSchema = z.object({
  segments: z.array(routePlanningSegmentInputSchema).default([]),
  city: z.string().optional(),
});

export const guideRequestSchema = z
  .object({
    content: z.string().trim().optional(),
    images: z.array(z.string().trim().min(1)).optional(),
  })
  .superRefine((value, ctx) => {
    const hasContent = Boolean(value.content && value.content.length > 0);
    const hasImages = Boolean(value.images && value.images.length > 0);
    if (!hasContent && !hasImages) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "content or images is required",
      });
    }
  });
