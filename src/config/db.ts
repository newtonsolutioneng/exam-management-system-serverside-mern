// serverside/src/config/db.ts
import mongoose from 'mongoose';
import config from './config';


const connectDB = async () => {
  try {
    // await mongoose.connect(config.databaseURI);
    // The link to a hosted database can be very slow (measured ~40 KB/s here), so compress everything on the wire.
    // zlib is built into Node and supported by Atlas. Set DB_COMPRESSION=off to disable.
    await mongoose.connect(config.databaseURI, {
      ...(process.env.DB_COMPRESSION === "off" ? {} : { compressors: ["zlib"] as any, zlibCompressionLevel: 6 as any }),
      maxPoolSize: 30,
    });
          //await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/medihub');
    console.log('✅ MongoDB connected');

      // GIVE MONGOOSE TIME TO INITIALIZE MODELS
    await new Promise(resolve => setTimeout(resolve, 1000));
    
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

export default connectDB;