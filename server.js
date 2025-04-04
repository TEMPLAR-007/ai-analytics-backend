// Successful version 1.0 with PostgreSQL integration
import express from 'express';
import bodyParser from 'body-parser';
import { Groq } from 'groq-sdk';
import multer from 'multer';
import xlsx from 'xlsx';
import cors from 'cors';
import pkg from 'pg';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import NodeCache from 'node-cache';
import compression from 'compression';
import fs from 'fs';
import PQueue from 'p-queue';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// Initialize cache with 5 minutes TTL
const cache = new NodeCache({ stdTTL: 300 });

// Security middleware
app.use(helmet());
const allowedOrigins = [
    "http://localhost:5173",
    "https://ai-analytics-frontend.onrender.com"
];

app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error("Not allowed by CORS"));
        }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
    optionsSuccessStatus: 200
}));


// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 500, // increased from 100 to 500 requests per windowMs
    message: { error: "Too many requests, please try again later" },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

// Create a less restrictive limiter for the /tables endpoint
const tablesLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 60, // 60 requests per minute
    message: { error: "Too many table requests, please try again later" }
});

app.use(limiter);

// Body parser with size limits
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// Initialize Groq client with API key from environment variables
const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

// Configure multer with file size limits and type validation
const upload = multer({
    dest: 'uploads/',
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB limit
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
            file.mimetype === 'application/vnd.ms-excel') {
            cb(null, true);
        } else {
            cb(new Error('Only Excel files are allowed!'), false);
        }
    }
});

// Add compression middleware
app.use(compression());

// Cache middleware for GET requests
const cacheMiddleware = (duration) => {
    return (req, res, next) => {
        if (req.method !== 'GET') {
            return next();
        }

        const key = req.originalUrl;
        const cachedResponse = cache.get(key);

        if (cachedResponse) {
            return res.json(cachedResponse);
        }

        res.originalJson = res.json;
        res.json = (body) => {
            cache.set(key, body, duration);
            res.originalJson(body);
        };
        next();
    };
};

// Optimize database queries with connection pooling
// const pool = new pkg.Pool({
//     user: process.env.DB_USER,
//     host: process.env.DB_HOST,
//     database: process.env.DB_NAME,
//     password: process.env.DB_PASSWORD,
//     port: process.env.DB_PORT,
//     ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
//     max: 20, // Maximum number of clients in the pool
//     idleTimeoutMillis: 30000, // How long a client is allowed to remain idle before being closed
//     connectionTimeoutMillis: 2000, // How long to wait before timing out when connecting a new client
// });

// for render deployment
const pool = new pkg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
    max: 20, // Maximum number of clients in the pool
    idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
    connectionTimeoutMillis: 2000 // Timeout if a connection takes too long
});

pool.connect()
    .then(() => console.log("✅ PostgreSQL Pool Connected"))
    .catch(err => console.error("❌ PostgreSQL Pool Connection Error:", err));

// Add this after your database connection setup
async function ensureTableStructure() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Check if columns exist and add them if they don't
        const checkColumns = await client.query(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'tables_registry'
            AND column_name IN ('example_queries', 'data_summary');
        `);

        if (checkColumns.rows.length < 2) {
            await client.query(`
                ALTER TABLE tables_registry
                ADD COLUMN IF NOT EXISTS example_queries JSONB,
                ADD COLUMN IF NOT EXISTS data_summary JSONB;
            `);
        }

        await client.query('COMMIT');
        console.log('✅ Table structure updated successfully');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error updating table structure:', error);
    } finally {
        client.release();
    }
}

// Call this function when your server starts
ensureTableStructure().catch(console.error);

//function to verify table exists in database
async function verifyTableExists(tableName) {
    try {
        const query = `
            SELECT EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_name = $1
            );
        `;
        const result = await pool.query(query, [tableName]);
        return result.rows[0].exists;
    } catch (error) {
        console.error("Error verifying table:", error);
        return false;
    }
}

// Queue for AI requests with concurrency limit and rate limiting
const aiQueue = new PQueue({
    concurrency: 1, // Process one request at a time
    interval: 1000, // Minimum time between requests (1 second)
    intervalCap: 1  // Maximum number of requests per interval
});

// Modify the upload endpoint to clean up files
app.post('/upload', upload.single('file'), async (req, res, next) => {
    if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
    }

    try {
        const workbook = xlsx.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const data = xlsx.utils.sheet_to_json(sheet);

        // Delete the temporary file after reading
        fs.unlink(req.file.path, (err) => {
            if (err) {
                console.error('Error deleting temporary file:', err);
            } else {
                console.log('Temporary file deleted successfully');
            }
        });

        if (data.length === 0) {
            throw new Error("Excel file is empty");
        }

        const originalFileName = req.file.originalname.replace(/\.[^/.]+$/, "");
        const sanitizedFileName = originalFileName.replace(/[^a-zA-Z0-9]/g, "_");
        const tableName = `${sanitizedFileName}_${Date.now()}`;

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Create tables_registry if it doesn't exist
            await client.query(`
                CREATE TABLE IF NOT EXISTS tables_registry (
                    id SERIAL PRIMARY KEY,
                    table_name TEXT UNIQUE,
                    original_file_name TEXT,
                    upload_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    columns JSONB,
                    example_queries JSONB,
                    data_summary JSONB
                );
            `);

            // Create the data table
            const createTableQuery = `
                CREATE TABLE IF NOT EXISTS ${tableName} (
                    id SERIAL PRIMARY KEY,
                    ${Object.keys(data[0]).map(col => {
                const sampleValue = data[0][col];
                const type = typeof sampleValue === 'number' ? 'NUMERIC' : 'TEXT';
                return `"${col}" ${type}`;
            }).join(',\n')}
                );
            `;
            await client.query(createTableQuery);

            // Insert the data
            for (const row of data) {
                const columns = Object.keys(row);
                const values = columns.map(col => row[col]);
                const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

                await client.query(
                    `INSERT INTO ${tableName} (${columns.map(col => `"${col}"`).join(', ')})
                     VALUES (${placeholders})`,
                    values.map(value => (typeof value === 'number' ? Number(value) : value))
                );
            }

            // Register the table
            await client.query(`
                INSERT INTO tables_registry (table_name, original_file_name, columns)
                VALUES ($1, $2, $3)
            `, [tableName, req.file.originalname, JSON.stringify(Object.keys(data[0]))]);

            // Start async processing of insights
            processDataInsights(tableName, data, pool).catch(console.error);

            await client.query('COMMIT');

            res.json({
                message: "File uploaded and data stored successfully",
                tableName: tableName,
                originalFileName: req.file.originalname,
                columns: Object.keys(data[0]),
                totalRows: data.length
            });
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }

    } catch (error) {
        // Clean up the file even if processing fails
        if (req.file) {
            fs.unlink(req.file.path, (err) => {
                if (err) console.error('Error deleting temporary file:', err);
            });
        }
        next(error);
    }
});

// Modify the tables endpoint to use the less restrictive limiter
app.get('/tables', tablesLimiter, async (req, res, next) => {
    try {
        const result = await pool.query(`
            SELECT * FROM tables_registry
            ORDER BY upload_date DESC
        `);
        res.json(result.rows);
    } catch (error) {
        next(error);
    }
});

// Modify the query endpoint to handle queries without table name
app.post("/query", async (req, res, next) => {
    const { query, tableName } = req.body;

    if (!query) {
        return res.status(400).json({ error: "Query is required" });
    }

    try {
        // If no table name provided, get the most recent table
        let targetTable = tableName;
        if (!targetTable) {
            const latestTable = await pool.query(`
                SELECT table_name
                FROM tables_registry
                ORDER BY upload_date DESC
                LIMIT 1
            `);

            if (latestTable.rows.length === 0) {
                return res.status(404).json({ error: "No tables found. Please upload data first." });
            }

            targetTable = latestTable.rows[0].table_name;
        }

        // Verify table exists
        const tableExists = await verifyTableExists(targetTable);
        if (!tableExists) {
            return res.status(404).json({ error: "Table not found in database" });
        }

        const sql = await queryAIForSQL(query, targetTable);
        const filteredData = await executeSQL(sql);
        const chartData = await queryAIForChart(query, filteredData);

        res.json({
            query,
            sql,
            filteredData,
            chartData,
            tableName: targetTable
        });
    } catch (error) {
        next(error);
    }
});

// Update queryAIForSQL to handle the table name properly
async function queryAIForSQL(query, tableName) {
    try {
        // Get schema for the specific table
        const schemaQuery = `
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = $1;
        `;
        const schema = await pool.query(schemaQuery, [tableName]);

        // Get sample data from the specific table
        const sampleData = await pool.query(`
            SELECT *
            FROM ${tableName}
            LIMIT 5;
        `);

        const schemaDescription = schema.rows
            .map(col => `"${col.column_name}" (${col.data_type})`)
            .join(", ");

        const columnsList = schema.rows.map(col => `"${col.column_name}"`).join(', ');

        const prompt = `
        You are an AI that converts natural language queries into valid PostgreSQL queries.

        **Table Schema:**
        - Table name: ${tableName}
        - Columns: ${schemaDescription}

        **CRITICAL SQL FORMATTING RULES:**
        1. ALWAYS enclose column names in double quotes to preserve case sensitivity
           Correct: SELECT "Category", "Total"
           Incorrect: SELECT Category, Total

        2. Example of proper column quoting:
           - For single column: SELECT "Customer Name"
           - For aggregates: SELECT "Category", SUM("Total")
           - In WHERE clause: WHERE "Order Date" > '2024-01-01'
           - In GROUP BY: GROUP BY "Category", "Status"

        **Available Columns (always use exactly as shown with quotes):**
        ${columnsList}

        **Sample Data:**
        ${JSON.stringify(sampleData.rows, null, 2)}

        **Additional SQL Rules:**
        1. When using aggregate functions (SUM, COUNT, AVG, etc.), all non-aggregated columns MUST be included in GROUP BY
        2. If mixing aggregate and non-aggregate columns, use GROUP BY for all non-aggregated columns
        3. Always return ONLY the SQL query with NO additional text
        4. Use ILIKE for case-insensitive filtering
        5. For simple totals, avoid selecting individual columns unless needed
        6. Always use the table name: ${tableName}

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
            .replace(/<think>[\s\S]*?<\/think>/g, "")
            .replace(/```sql|```/g, "")
            .trim()
            .split(";")[0];

        // Validate that all column references are properly quoted
        const columnNames = schema.rows.map(col => col.column_name);
        const unquotedColumns = columnNames.filter(col =>
            sql.includes(` ${col} `) || sql.includes(`${col},`) || sql.includes(`,${col}`)
        );

        if (unquotedColumns.length > 0) {
            // If we find unquoted columns, modify the query to add quotes
            let fixedSql = sql;
            unquotedColumns.forEach(col => {
                const regex = new RegExp(`\\b${col}\\b`, 'g');
                fixedSql = fixedSql.replace(regex, `"${col}"`);
            });
            return fixedSql;
        }

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
        const result = await pool.query(sql);
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

// Modify the generateExampleQueries function
async function generateExampleQueries(data, columns) {
    return aiQueue.add(async () => {
        try {
            const prompt = `
            Given this dataset with columns: ${columns.join(', ')}
            And sample data: ${JSON.stringify(data.slice(0, 3))}

            Return ONLY a JSON array of 5 example queries. No explanation, no thinking process, no json keyword, no backticks.
            Example format:
            [
                "Show me total sales by category",
                "What are the top 5 customers by order value",
                "How many orders are in each status",
                "What is the average order value",
                "Show me sales trends over time"
            ]
            `;

            const chatCompletion = await groq.chat.completions.create({
                messages: [{ role: "user", content: prompt }],
                model: "deepseek-r1-distill-llama-70b",
                temperature: 0.7,
                max_completion_tokens: 4096,
                top_p: 0.95,
                stream: false,
            });

            let content = chatCompletion.choices[0].message.content.trim();

            content = content
                .replace(/<think>[\s\S]*?<\/think>/g, '')
                .replace(/```[\s\S]*?```/g, '')
                .replace(/^json\s*/i, '')
                .replace(/^[\s\n]*\[/, '[')
                .replace(/\][\s\n]*$/, ']')
                .trim();

            try {
                return JSON.parse(content);
            } catch (parseError) {
                console.error("Error parsing AI response:", parseError);
                return ["Show me all data", "Count total rows", "Show summary statistics"];
            }
        } catch (error) {
            console.error("Error generating example queries:", error);
            return ["Show me all data", "Count total rows", "Show summary statistics"];
        }
    });
}

// Modify the generateDataSummary function
async function generateDataSummary(data, columns) {
    return aiQueue.add(async () => {
        try {
            const prompt = `
            Analyze this dataset:
            Columns: ${columns.join(', ')}
            Sample data: ${JSON.stringify(data.slice(0, 5))}
            Total rows: ${data.length}

            Return ONLY a JSON object with a summary paragraph. No explanation, no thinking process, no json keyword, no backticks.
            Example format:
            {
                "summary": "This dataset contains sales information with X rows..."
            }
            `;

            const chatCompletion = await groq.chat.completions.create({
                messages: [{ role: "user", content: prompt }],
                model: "deepseek-r1-distill-llama-70b",
                temperature: 0.7,
                max_completion_tokens: 4096,
                top_p: 0.95,
                stream: false,
            });

            let content = chatCompletion.choices[0].message.content.trim();

            content = content
                .replace(/<think>[\s\S]*?<\/think>/g, '')
                .replace(/```[\s\S]*?```/g, '')
                .replace(/^json\s*/i, '')
                .replace(/^[\s\n]*{/, '{')
                .replace(/}[\s\n]*$/, '}')
                .trim();

            try {
                return JSON.parse(content);
            } catch (parseError) {
                console.error("Error parsing AI response. Content:", content);
                return {
                    summary: `This dataset contains ${data.length} rows with ${columns.length} columns (${columns.join(', ')}). You can analyze this data using various queries to gain insights into the patterns and relationships within the information.`
                };
            }
        } catch (error) {
            console.error("Error generating data summary:", error);
            return {
                summary: `This dataset contains ${data.length} rows with ${columns.length} columns (${columns.join(', ')}). You can analyze this data using various queries to gain insights into the patterns and relationships within the information.`
            };
        }
    });
}

// Modify processDataInsights to handle the queue
async function processDataInsights(tableName, data, client) {
    try {
        console.log(`🔄 Starting insight generation for table ${tableName}...`);

        // Generate insights asynchronously with proper queuing
        const [exampleQueries, dataSummary] = await Promise.all([
            generateExampleQueries(data, Object.keys(data[0])),
            generateDataSummary(data, Object.keys(data[0]))
        ]);

        // Update the registry with the generated insights
        await client.query(`
            UPDATE tables_registry
            SET example_queries = $1, data_summary = $2
            WHERE table_name = $3
        `, [JSON.stringify(exampleQueries), JSON.stringify(dataSummary), tableName]);

        console.log(`✅ Generated insights for table ${tableName}`);
    } catch (error) {
        console.error(`❌ Error generating insights for table ${tableName}:`, error);
    }
}

// Error handling middleware
const errorHandler = (err, req, res, next) => {
    console.error(err.stack);

    // Handle specific error types
    if (err.name === 'MulterError') {
        return res.status(400).json({
            error: 'File upload error',
            message: err.message
        });
    }

    if (err.name === 'ValidationError') {
        return res.status(400).json({
            error: 'Validation error',
            message: err.message
        });
    }

    // Default error
    res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
    });
};

// Request logging middleware
const requestLogger = (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`${req.method} ${req.url} - ${res.statusCode} - ${duration}ms`);
    });
    next();
};

app.use(requestLogger);
app.use(errorHandler);

// Add caching to data endpoint
app.get("/data", cacheMiddleware(300), async (req, res) => {
    if (uploadedData.length === 0) {
        return res.status(400).json({ error: "No data available" });
    }

    try {
        const result = await pool.query(`
            SELECT name, SUM(total_sales) as totalSales
            FROM uploaded_data
            GROUP BY name
            ORDER BY totalSales DESC
        `);

        res.json({ chartData: result.rows });
    } catch (error) {
        next(error);
    }
});

// Add endpoint to delete a specific table
app.delete('/table/:tableName', async (req, res, next) => {
    const { tableName } = req.params;

    try {
        // Verify table exists
        const tableExists = await verifyTableExists(tableName);
        if (!tableExists) {
            return res.status(404).json({ error: "Table not found" });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Delete the table
            await client.query(`DROP TABLE IF EXISTS ${tableName}`);

            // Remove from registry
            await client.query(
                'DELETE FROM tables_registry WHERE table_name = $1',
                [tableName]
            );

            await client.query('COMMIT');

            res.json({
                message: `Table ${tableName} successfully deleted`,
                deletedTable: tableName
            });
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (error) {
        next(error);
    }
});

// Add endpoint to delete all tables
app.delete('/tables/all', async (req, res, next) => {
    try {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Get all table names from registry
            const result = await client.query('SELECT table_name FROM tables_registry');
            const tables = result.rows;

            // Drop each table
            for (const table of tables) {
                await client.query(`DROP TABLE IF EXISTS ${table.table_name}`);
            }

            // Clear the registry
            await client.query('DELETE FROM tables_registry');

            await client.query('COMMIT');

            res.json({
                message: "All tables successfully deleted",
                deletedCount: tables.length,
                deletedTables: tables.map(t => t.table_name)
            });
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (error) {
        next(error);
    }
});

// Add OPTIONS handling for preflight requests
app.options('*', cors()); // Enable pre-flight for all routes

//cleanup function for the uploads folder
function cleanupUploadsFolder() {
    const uploadsDir = 'uploads';

    // Create uploads directory if it doesn't exist
    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir);
        return;
    }

    // Read all files in the uploads directory
    fs.readdir(uploadsDir, (err, files) => {
        if (err) {
            console.error('Error reading uploads directory:', err);
            return;
        }

        // Delete each file
        files.forEach(file => {
            const filePath = `${uploadsDir}/${file}`;
            fs.unlink(filePath, (err) => {
                if (err) {
                    console.error(`Error deleting file ${file}:`, err);
                } else {
                    console.log(`Deleted temporary file: ${file}`);
                }
            });
        });
    });
}

// Clean up uploads folder when server starts
cleanupUploadsFolder();

// Optional: Add periodic cleanup (e.g., every hour)
setInterval(cleanupUploadsFolder, 3600000); // 1 hour in milliseconds

// Add new endpoint for fetching table insights
app.get('/table-insights/:tableName', async (req, res, next) => {
    try {
        const { tableName } = req.params;

        // Check if insights exist in cache
        const cacheKey = `insights_${tableName}`;
        const cachedInsights = cache.get(cacheKey);
        if (cachedInsights) {
            return res.json(cachedInsights);
        }

        // Fetch insights from database
        const result = await pool.query(`
            SELECT example_queries, data_summary
            FROM tables_registry
            WHERE table_name = $1
        `, [tableName]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Table not found" });
        }

        const insights = {
            exampleQueries: result.rows[0].example_queries || [],
            dataSummary: result.rows[0].data_summary || {
                summary: "Analysis in progress"
            }
        };

        // Cache the insights
        cache.set(cacheKey, insights, 300); // Cache for 5 minutes

        res.json(insights);
    } catch (error) {
        next(error);
    }
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
})