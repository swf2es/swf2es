// What a SWF 7 has besides: getNextHighestDepth and getInstanceAtDepth.
trace("next " + getNextHighestDepth() + " " + c1.getNextHighestDepth());
trace("at " + getInstanceAtDepth(5)._name + " " + typeof getInstanceAtDepth(6) + " " + getInstanceAtDepth(-16383)._name);
var t = createEmptyMovieClip("t", 1000);
trace("next " + getNextHighestDepth());
