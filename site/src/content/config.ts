import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string().max(160),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    tags: z.array(z.string()).default([]),
    category: z.string().default('backend'),
    draft: z.boolean().default(false),
    // set true for posts the AI pipeline generated, false for ones you wrote yourself
    aiAssisted: z.boolean().default(false),
    readingTime: z.number().optional()
  })
});

export const collections = { blog };
