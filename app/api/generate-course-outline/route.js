import { courseOutlineAIModel } from "@/configs/AiModel";
import { NextResponse } from "next/server";
import { STUDY_MATERIAL_TABLE } from "@/configs/schema";
import { db } from "@/configs/db";
import { inngest } from "@/inngest/client";

export async function POST(req) {
    try {
        const { courseId, topic, courseType, difficultyLevel, createdBy } = await req.json();

        const PROMPT = `Generate a study material for ${topic} for ${courseType} and level of difficulty will be ${difficultyLevel} with summary of course. List of chapters (Max 3) along with summary and Emoji icon for each chapter, Topic list in each chapter in JSON format`;

        const aiResponse = await courseOutlineAIModel.sendMessage(PROMPT);
        const aiResult = JSON.parse(aiResponse.response.text());
        console.log("AI Result:", aiResult); 

        const dbResult = await db.insert(STUDY_MATERIAL_TABLE).values({
            courseId,
            courseType,
            createdBy,
            topic,
            difficultyLevel,
            courseLayout: aiResult,
        }).returning({ resp: STUDY_MATERIAL_TABLE });

        console.log(`From generate course outline api - : ${dbResult[0]}`);

        // *** THIS IS THE KEY CHANGE ***
        const courseLayout = dbResult[0].resp.courseLayout; // Extract the courseLayout

        const noteGenerateNote = await inngest.send({
            name: "notes.generate",
            data: {
                course: {
                    ...dbResult[0].resp, // Include other course details if needed
                    courseLayout: courseLayout, // Send ONLY the courseLayout to Inngest
                },
            },
        });

        return NextResponse.json({ result: dbResult[0] });
    } catch (error) {
        console.error("Error in POST handler:", error);
        return NextResponse.json({ message: "Internal Server Error" });
    }
}