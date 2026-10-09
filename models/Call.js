import mongoose from "mongoose";

// An open call: someone says what they are looking for (a vocalist, an illustrator, a photographer for a shoot) and people who might fit
// apply with a few words and one of their own pieces. Nothing is paid or promised through the site; it gets the right two people talking.
const callSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true, maxlength: 80 },
    details: { type: String, required: true, maxlength: 1500 },
    // what kind of person it is looking for, as tags like the ones people list on their profile ("vocalist", "logo design")
    lookingFor: { type: [String], default: [] },
    // free text on purpose ("unpaid, credit and a copy", "around 200"): only a hint
    budget: { type: String, default: "", maxlength: 40 },
    // the last day people can apply (a day, stored as that day's midnight UTC); null for no end
    deadline: { type: Date, default: null },
    status: { type: String, enum: ["open", "closed"], default: "open" },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

callSchema.index({ status: 1, _id: -1 });
callSchema.index({ owner: 1, _id: -1 });

export const Call = mongoose.model("Call", callSchema);
