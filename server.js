// import express from 'express';
// import bodyParser from 'body-parser';
// import { Groq } from 'groq-sdk'; // Import Groq SDK
// import multer from 'multer'; // For file uploads
// import xlsx from 'xlsx'; // For reading Excel files
// import cors from 'cors';

// const { version } = require("xlsx");

// const app = express();
// const port = 3000;

// app.use(cors({
//     origin: "http://localhost:5173", // Allow frontend URL
//     methods: ["GET", "POST"],        // Allow only necessary methods
//     allowedHeaders: ["Content-Type"] // Allow required headers
// }));

// // Initialize Groq client with your API key
// const groq = new Groq({
//     apiKey: "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"
// });

// // Middleware to parse incoming JSON requests
// app.use(bodyParser.json());

// // Configure multer for file uploads
// const upload = multer({ dest: 'uploads/' }); // Files will be temporarily saved in the 'uploads' folder

// // Variable to store uploaded data
// let uploadedData = [];

// // Endpoint to upload an Excel file
// app.post('/upload', upload.single('file'), (req, res) => {
//     if (!req.file) {
//         return res.status(400).json({ error: "No file uploaded" });
//     }

//     try {
//         // Read the uploaded Excel file
//         const workbook = xlsx.readFile(req.file.path);
//         const sheetName = workbook.SheetNames[0]; // Get the first sheet
//         const sheet = workbook.Sheets[sheetName];

//         // Convert the sheet to JSON
//         uploadedData = xlsx.utils.sheet_to_json(sheet);

//         // Log the uploaded data for debugging
//         console.log("Uploaded Data:", uploadedData);

//         res.json({ message: "File uploaded successfully", data: uploadedData });
//     } catch (error) {
//         console.error("Error processing file:", error);
//         res.status(500).json({ error: "Failed to process the file" });
//     }
// });

// // Define the queryAI function using Groq SDK
// async function queryAI(query, data) {
//     try {
//         const prompt = `
// You are an AI that processes structured JSON data and generates insights, including charts.

// **Dataset:**
// ${JSON.stringify(data)}

// **Task:**
// - If the query requires filtering, return **only relevant records**.
// - If the query requires a calculation, compute the result and include it in the response.
// - If the query requires a **chart**, return **chart-ready data** formatted for visualization.
// - Ensure the response is **valid JSON** with NO extra text.

// **Example Outputs:**
// 1️⃣ **For filtering**:
// \`\`\`json
// {
//     "filtered_data": [
//         { "name": "Laptop", "category": "Electronics", "total_sales": 67499.25 }
//     ]
// }
// \`\`\`

// 2️⃣ **For calculation**:
// \`\`\`json
// {
//     "total_sales": 142497.65
// }
// \`\`\`

// 3️⃣ **For charts** (e.g., last-selling products by date):
// \`\`\`json
// {
//     "chart": {
//         "title": "Sales Trend (Last Sold Items)",
//         "type": "bar",
//         "labels": ["2025-01-25", "2025-02-10", "2025-01-30", "2025-01-28"],
//         "datasets": [
//             {
//                 "label": "Total Sales",
//                 "data": [59999, 67499.25, 5998.8, 59998],
//                 "backgroundColor": ["#ff6384", "#36a2eb", "#ffce56", "#4bc0c0"]
//             }
//         ]
//     }
// }
// \`\`\`

// //         **User Query:** "${query}"
// //         `;

//         const chatCompletion = await groq.chat.completions.create({
//             messages: [{ role: "user", content: prompt }],
//             model: "deepseek-r1-distill-llama-70b",
//             temperature: 0.3,
//             max_completion_tokens: 4096,
//             top_p: 0.95,
//             stream: false
//         });

//         // Extract AI response
//         const content = chatCompletion.choices[0].message.content.trim();

//         // Remove potential Markdown JSON formatting
//         const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
//         const jsonString = jsonMatch ? jsonMatch[1] : content;

//         // Ensure response is valid JSON
//         return JSON.parse(jsonString);
//     } catch (error) {
//         console.error("Error fetching from Groq API:", error.message);
//         return { error: "Failed to process AI response" };
//     }
// }


// // Handle POST request to process the query
// app.post("/query", async (req, res) => {
//     const { query } = req.body;

//     if (!query || uploadedData.length === 0) {
//         return res.status(400).json({ error: "Query and uploaded data are required" });
//     }

//     try {
//         const filteredData = await queryAI(query, uploadedData);
//         res.json(filteredData); // Send back only the relevant records
//     } catch (error) {
//         console.error("Error processing query:", error);
//         res.status(500).json({ error: "Internal Server Error" });
//     }
// });


// // Endpoint to get data for visualizations
// app.get("/data", (req, res) => {
//     if (uploadedData.length === 0) {
//         return res.status(400).json({ error: "No data available" });
//     }

//     // Example: Return data for a bar chart (total sales by product)
//     const chartData = uploadedData.map(item => ({
//         name: item.name,
//         totalSales: parseFloat(item.total_sales),
//     }));

//     res.json({ chartData });
// });

// // Start the server
// app.listen(port, () => {
//     console.log(`Server is running on http://localhost:${port}`);
// });































// Successful version 1.0 with PostgreSQL integration
import express from 'express';
import bodyParser from 'body-parser';
import { Groq } from 'groq-sdk';
import multer from 'multer';
import xlsx from 'xlsx';
import cors from 'cors';
import pkg from 'pg';
const { Client } = pkg;

const app = express();
const port = 3000;

// Middleware
app.use(cors({
    origin: "http://localhost:5173",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
}));
app.use(bodyParser.json());

const groq = new Groq({
    apiKey: "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",
});

const upload = multer({ dest: 'uploads/' });

// PostgreSQL client
const pgClient = new Client({
    user: 'postgres',
    host: 'localhost',
    database: 'sales_db',
    password: 'postgres',
    port: 5432,
});

pgClient.connect()
    .then(() => console.log("Connected to PostgreSQL"))
    .catch(err => console.error("PostgreSQL connection error:", err));

app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
    }

    try {
        const workbook = xlsx.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const data = xlsx.utils.sheet_to_json(sheet);

        for (const row of data) {
            await pgClient.query(
                'INSERT INTO uploaded_data (name, category, total_sales) VALUES ($1, $2, $3)',
                [row.name, row.category, row.total_sales]
            );
        }

        res.json({ message: "File uploaded and data stored successfully" });
    } catch (error) {
        console.error("Error processing file:", error);
        res.status(500).json({ error: "Failed to process the file" });
    }
});

async function getTableSchema() {
    try {
        const schemaQuery = `
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_name = 'uploaded_data';
        `;
        const schemaResult = await pgClient.query(schemaQuery);
        return schemaResult.rows;
    } catch (error) {
        console.error("Error fetching schema:", error);
        throw new Error("Failed to fetch table schema");
    }
}

// Function to convert natural language query to SQL using Groq API
async function queryAIForSQL(query) {
    try {
        const schema = await getTableSchema();
        const sampleData = await pgClient.query(`
            SELECT *
            FROM uploaded_data
            LIMIT 5;
        `);

        const schemaDescription = schema
            .map(col => `${col.column_name} (${col.data_type})`)
            .join(", ");

        const prompt = `
        You are an AI that converts natural language queries into valid SQL queries for PostgreSQL.

        **Table Schema:**
        - Table name: uploaded_data
        - Columns: ${schemaDescription}

        **Sample Data:**
        ${JSON.stringify(sampleData.rows, null, 2)}

        **Task:**
        - Analyze the user's query and generate a valid SQL query based on the dataset schema and sample data.
        - Use the dataset's column names and data types to infer the appropriate SQL logic.
        - If the query involves filtering, use the relevant columns (e.g., "name", "category") and generate the appropriate condition.
        - If the query involves calculations (e.g., sum, average, count), use the appropriate aggregation function.
        - If the query involves sorting, include ORDER BY with the appropriate column and direction (ASC/DESC).
        - If the query involves grouping, use GROUP BY with the appropriate column.
        - If the query involves limiting results, use LIMIT.

        **Rules:**
        1. Always return **ONLY the SQL query** with NO additional text or explanations.
        2. Use ILIKE for case-insensitive filtering.
        3. Use PostgreSQL date functions (e.g., NOW(), INTERVAL) for time-based queries.

        **User Query:** "${query}"
        `;

        const chatCompletion = await groq.chat.completions.create({
            messages: [{ role: "user", content: prompt }],
            model: "deepseek-r1-distill-llama-70b",
            temperature: 0.3,
            max_completion_tokens: 4096,
            top_p: 0.95,
            stream: false,
        });

        const content = chatCompletion.choices[0].message.content.trim();
        const sql = content
            .replace(/<think>[\s\S]*?<\/think>/g, "") // Remove <think> blocks
            .replace(/```sql|```/g, "") // Remove markdown formatting
            .trim()
            .split(";")[0];

        console.log("Generated SQL:", sql);
        return sql;
    } catch (error) {
        console.error("Error generating SQL:", error);
        throw new Error("Failed to generate SQL query");
    }
}

// Function to execute SQL queries
async function executeSQL(sql) {
    if (!sql.toLowerCase().startsWith("select")) {
        throw new Error("Only SELECT queries are allowed.");
    }

    try {
        const result = await pgClient.query(sql);
        return result.rows;
    } catch (error) {
        console.error("SQL Error:", error.message);
        throw new Error("Invalid SQL Query.");
    }
}



async function queryAIForChart(query, data) {
    try {
        const prompt = `
        You are an AI that processes structured JSON data and generates insights, including charts.

        **Dataset:**
        ${JSON.stringify(data)}

        **Task:**
- Analyze the dataset and determine the best chart type:
  - If data contains **categories and numerical values**, use a **bar or pie chart**.
  - If data has **time-series data**, use a **line chart**.
  - If the query asks for **comparisons**, use a **bar or grouped bar chart**.
  - If the dataset has **two numerical variables**, use a **scatter chart**.

- Return the output in a structured JSON format with **no extra text**.
- Ensure the response includes:
  1. **chart_type**: ("bar", "line", "pie", "scatter", etc.)
  2. **data**: Contains labels & values formatted for a chart.
  3. **config**: Custom styling options.

        **User Query:** "${query}"
        `;

        const chatCompletion = await groq.chat.completions.create({
            messages: [{ role: "user", content: prompt }],
            model: "deepseek-r1-distill-llama-70b",
            temperature: 0.3,
            max_completion_tokens: 4096,
            top_p: 0.95,
            stream: false,
        });

        /// Extract AI-generated chart response
        const content = chatCompletion.choices[0].message.content.trim();
        const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
        const jsonString = jsonMatch ? jsonMatch[1] : content;

        // Parse JSON response
        const chartData = JSON.parse(jsonString);

        // Validate & return the AI-generated chart configuration
        return chartData;

    } catch (error) {
        console.error("Error processing chart data:", error);
        return { error: "Failed to generate chart data" };
    }
}


// Endpoint to handle user queries
app.post("/query", async (req, res) => {
    const { query } = req.body;

    if (!query) {
        return res.status(400).json({ error: "Query is required" });
    }

    try {
        const sql = await queryAIForSQL(query);
        const filteredData = await executeSQL(sql);

        const chartData = await queryAIForChart(query, filteredData);

        res.json({
            query,
            sql,
            filteredData,
            chartData,
        });
    } catch (error) {
        console.error("Error processing query:", error);
        res.status(500).json({ error: error.message || "Internal Server Error" });
    }
});


// Start the server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
})