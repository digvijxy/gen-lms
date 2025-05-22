import { inngest } from "./client";
import { db } from "@/configs/db";
import { CHAPTER_NOTES_TABLE, STUDY_MATERIAL_TABLE, STUDY_TYPE_CONTENT_TABLE, USER_TABLE } from "@/configs/schema";
import { eq } from "drizzle-orm";
import {
    generateFlashCardAiModel,
    generateNotesAiModel, generateQAAiModel,
    generateQuizAiModel,
} from "@/configs/AiModel";

export const CreateNewUser = inngest.createFunction(
    { id: "create-user" },
    { event: "user.create" },

    async ({ event, step }) => {
        const result = await step.run("Check User and create New if not in DB", async () => {
            try {
                // Check if the user already exists
                const existingUser = await db
                    .select()
                    .from(USER_TABLE)
                    .where(eq(USER_TABLE.email, event.data.user?.primaryEmailAddress?.emailAddress));

                if (existingUser?.length === 0) {
                    const newUser = await db
                        .insert(USER_TABLE)
                        .values({
                            name: event.data.user?.fullName,
                            email: event.data.user?.primaryEmailAddress?.emailAddress,
                        })
                        .returning({ id: USER_TABLE.id });

                    return newUser;
                }

                return existingUser;
            } catch (error) {
                console.error(`Error in creating user: ${error.message}`, error.stack);
                throw new Error("Failed to create or check user");
            }
        });

        return "success";
    }
);


export const GenerateNotes = inngest.createFunction(
    { id: "generate-course" },
    { event: "notes.generate" },
    async ({ event, step }) => {
        const course = event.data.course;

        console.log(`Event data from generate notes:`, course);
        const courseId = course.courseId;
        console.log(`Course ID: ${courseId}`);

        const chapters = course.courseLayout.chapters;
        console.log("Chapters:", chapters);

        if (!chapters || !Array.isArray(chapters) || chapters.length === 0) {
            console.error("No chapters found in the course layout. Check the data:", course.courseLayout);
            throw new Error("No chapters found in the course layout");
        }

        const notesResult = await step.run("Generate Chapter Notes", async () => {
            try {
                await Promise.all(
                    chapters.map(async (chapter) => {
                        if (!chapter.topics || !Array.isArray(chapter.topics) || chapter.topics.length === 0) {
                            console.warn(`Chapter ${chapter.chapterNumber} has no topics. Skipping.`);
                            return; // Skip this chapter if it has no topics
                        }

                        await Promise.all( // Generate notes for each topic within the chapter
                          chapter.topics.map(async (topic) => {
                            const PROMPT = `You are a good Assistant, and you MUST follow my instructions precisely. Generate DETAILED, FULL TEXT content for the following TOPIC within a chapter. Do NOT provide a summary or outline. I need the COMPLETE TEXT of the topic, suitable for inclusion in a study guide.

                            The content should be in HTML format with inline styles (do NOT add HTML, head, body, or title tags).  Include detailed explanations, examples, and any relevant formulas.

                            The topic is: ${JSON.stringify(topic)}
                            The chapter title is: ${chapter.chapterTitle}

                            IMPORTANT: The output MUST be the full HTML content of the topic. It must NOT be a summary, outline, or list of points. It must be the complete, detailed text.`;

                            try {
                                const result = await generateNotesAiModel.sendMessage(PROMPT);
                                const topicContent = await result.response.text();

                                await db.insert(CHAPTER_NOTES_TABLE).values({
                                    chapterId: chapter.chapterNumber,
                                    topicId: topic.id, // Or however you identify the topic (Make sure this exists)
                                    courseId,
                                    notes: topicContent,
                                });
                            } catch (topicError) {
                                console.error(`Error generating notes for topic ${topic.id} in chapter ${chapter.chapterNumber}:`, topicError);
                                // Handle the error as needed (e.g., skip the topic, retry, etc.)
                            }
                        })
                      );
                    })
                );

                return "Chapter notes generated successfully";
            } catch (error) {
                console.error(`Error in generating notes: ${error.message}`, error.stack);
                throw new Error("Failed to generate chapter notes");
            }
        });

        const updateCourseStatusResult = await step.run("Update Course Status", async () => {
            try {
                await db.update(STUDY_MATERIAL_TABLE)
                    .set({ status: "ready" })
                    .where(eq(STUDY_MATERIAL_TABLE.courseId, courseId));

                return "Course status updated successfully";
            } catch (error) {
                console.error(`Error updating course status: ${error.message}`, error.stack);
                throw new Error("Failed to update course status");
            }
        });

        return {
            notesResult,
            updateCourseStatusResult,
        };
    }
);

// Use to generate flashcard, quiz, and Q&A
export const GenerateStudyTypeContent = inngest.createFunction(
    { id: "generate-study-type-content" },
    { event: "studyType.content" },
    async ({ event, step }) => {

        const { studyType, prompt, recordId } = event.data;

        console.log("STUDY TYPE ++++++++++++++++ " + studyType);
        console.log("PROMPT---------------------------------------------------" + prompt);
        console.log("RECORD ID --------------------------------------------" + recordId);

        try {
            const aiResponse_f = await step.run("Generating Content using AI", async () => {
                let result;

                // Run the appropriate AI generation model based on the study type
                try {
                    if (studyType === "flashcard") {
                        result = await generateFlashCardAiModel.sendMessage(prompt);
                    } else if (studyType === "quiz") {
                        result = await generateQuizAiModel.sendMessage(prompt);
                    } else if (studyType === "qa") {
                        result = await generateQAAiModel.sendMessage(prompt);
                    } else {
                        throw new Error("Invalid study type");
                    }

                    // Parse AI response to extract the content
                    const aiResponse = await result.response.text();
                    const parsedResponse = JSON.parse(aiResponse);

                    return parsedResponse;
                } catch (aiError) {
                    throw new Error(`AI generation failed: ${aiError.message}`);
                }
            });

            // Insert the generated content into the database
            await step.run("Save result to DB", async () => {
                try {
                    const dbResult = await db.update(STUDY_TYPE_CONTENT_TABLE)
                        .set({
                            content: aiResponse_f,
                            status: "ready"
                        })
                        .where(eq(STUDY_TYPE_CONTENT_TABLE.id, recordId));

                    if (!dbResult) {
                        throw new Error("Failed to update the database");
                    }

                    return 'Inserted successfully';
                } catch (dbError) {
                    throw new Error(`Database update failed: ${dbError.message}`);
                }
            });

        } catch (error) {
            // Handle any errors that occurred during the process
            console.error("Error generating study type content:", error.message);
            return { error: `Content generation failed: ${error.message}` };
        }
    }
);
