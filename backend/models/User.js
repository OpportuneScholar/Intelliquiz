const mongoose=require('mongoose');
const schema=new mongoose.Schema({
  name:{type:String,required:true,trim:true,maxlength:120},
  email:{type:String,required:true,unique:true,lowercase:true,trim:true,maxlength:254},
  passwordHash:{type:String,required:true},
  role:{type:String,enum:['student','teacher'],required:true},
  rollNumber:{type:String,trim:true,default:''},
  course:{type:String,trim:true,default:''},
  branch:{type:String,trim:true,default:''},
  mobile:{type:String,trim:true,default:''},
  isActive:{type:Boolean,default:true},
  passwordResetTokenHash:{type:String,default:undefined,select:false},
  passwordResetExpiresAt:{type:Date,default:undefined,select:false}
},{timestamps:true,versionKey:false});
module.exports=mongoose.models.User||mongoose.model('User',schema);
